# Gearline cutover — execution runbook

Follow top to bottom. Each stage has a **STOP condition**: if it fails, do not
continue to the next stage.

Total hands-on time: roughly 2–3 hours, most of it waiting on deploys.

`backend/` (the Java service) stays on disk and deployed until Stage 6. That is
your rollback.

---

## Stage 0 — Local verification (15 min, no deploy)

Confirm the code is sound on your machine before anything touches a server.

```bash
cd ~/workspace/gearline/backend-node

# Your node_modules was installed on macOS; that's correct for local work.
npm install

npm run check          # typecheck (src + test) then vitest
```

**Expect:** typecheck exits 0, tests pass.

### Also validate the nginx config

```bash
cd ~/workspace/gearline
chmod +x frontend/test-nginx-config.sh
./frontend/test-nginx-config.sh
```

**Expect:** `nginx: configuration file /etc/nginx/nginx.conf test is successful`

Run this on **every** change to `nginx.conf` or `proxy-common.conf`. A config
error there is not a degraded service — nginx refuses to start and the frontend
container crash-loops, taking the whole app down. It takes two seconds to check
and is invisible to code review: a duplicate `proxy_read_timeout` (set both in
the shared include and in a location block overriding it) did exactly this.

> If `npm test` complains about `@rollup/rollup-*` or `@esbuild/*`, delete
> `node_modules` and `package-lock.json` and re-run `npm install`. That's the
> known npm optional-dependency bug, not a code problem.

**STOP if:** typecheck reports errors. Send them to me.

---

## Stage 1 — Back up the database (5 min)

Do this even though nothing has changed yet. It is the only thing that protects
you from bad *data*, which no deploy mechanism does.

```bash
# On the VM
docker ps --format '{{.Names}}' | grep postgres     # find the container name

docker exec <postgres-container> pg_dump -U gearline gearline \
  | gzip > ~/gearline-backup-$(date +%F-%H%M).sql.gz

ls -lh ~/gearline-backup-*.sql.gz                    # confirm it's non-trivial
```

**STOP if:** the dump is under a few KB — that means it didn't actually run.

---

## Stage 2 — Verify credential decryption (10 min)

**This is the single most important check.** If the Node service cannot decrypt
what Java wrote, every marketplace connection silently dies on cutover.

Run it against a **copy** of production, or read-only against production — the
script never writes.

```bash
cd ~/workspace/gearline/backend-node

CREDENTIAL_ENCRYPTION_KEY='<exact value from the Beachhead dashboard>' \
DATABASE_URL='postgres://gearline:<password>@localhost:5432/gearline' \
npx tsx scripts/verify-credentials.ts
```

**Expect:**

```
Encryption mode: AES-256-GCM
  OK  SHOPIFY  My Store      -> 2 key(s): access_token(38), scope(112)
  OK  REVERB   Reverb Shop   -> 3 key(s): access_token(64), refresh_token(64), expires_at(13)
Readable: 3   Empty: 0   Failed: 0
```

**STOP if any row fails.** Almost always `CREDENTIAL_ENCRYPTION_KEY` differs
between what you passed and what the Java service has. Do not proceed.

---

## Stage 3 — JWT secret length — **ALREADY CONFIRMED**

Checked against the Beachhead dashboard values:

| Variable | Finding |
|---|---|
| `JWT_SECRET` | 64 chars, all ASCII hex → **64 bytes → 512 bits → HS512** |
| `CREDENTIAL_ENCRYPTION_KEY` | 64 chars, valid strict base64 → decodes to 48 bytes → truncated to 32 for AES-256. Java did exactly the same. |
| `EBAY_NOTIFICATION_VERIFICATION_TOKEN` | 64 chars, alphanumeric only → passes eBay's 32–80 + `[A-Za-z0-9_-]` rule |

So in Stage 4 the log line **must** read `algorithm: "HS512"  secretBytes: 64`.
Anything else means the dashboard value differs from what the container sees.

The encryption key is worth understanding: it *looks* like hex but is
**base64-decoded**, because that is what the Java `CredentialEncryptor` did.
64 base64 chars → 48 bytes → first 32 used as the AES key. The Node port
reproduces that byte for byte, including the truncation. Stage 2 proves it
empirically regardless.

For reference, your eBay notification endpoint is:

```
https://gearline.chicagoelectricpiano.com/api/v1/marketplace/ebay/notifications
```

That exact string — no trailing slash — must be what's registered in the
Developer Portal, because it is hashed into the challenge response.

---

## Stage 3.5 — Reclaim disk space (15 min)

A 20 GB VM running three apps should have plenty of room. If a deploy fails
with **`no space left on device`**, it is almost always Docker accumulating
images and build cache — Beachhead builds a fresh image every deploy, and the
old ones are not automatically removed.

### Diagnose

```bash
df -h /                          # confirm the root filesystem is the problem
docker system df                 # totals, with a RECLAIMABLE column
docker system df -v | head -60   # itemised

# Biggest images
docker images --format '{{.Size}}\t{{.Repository}}:{{.Tag}}' | sort -h -r | head -25

# Untagged layers left by previous builds — usually the bulk of it
docker images -f dangling=true | wc -l
```

### Reclaim

```bash
# 1. Safe: dangling images, stopped containers, unused networks, build cache.
#    Does NOT touch named volumes, so your database is untouched.
docker system prune -f

# 2. Build cache is often the single biggest item
docker builder prune -af

# 3. Images not used by any RUNNING container.
#    Only after a successful deploy — this removes rollback images too.
docker image prune -a -f

df -h /
```

**Never run `docker system prune --volumes`** or `docker volume prune`. Those
delete named volumes, which is where `gearline-postgres` lives.

### Keeping it from recurring

```bash
# Cap the journal, which quietly grows to a gigabyte or more
sudo journalctl --vacuum-size=200M

# Weekly cleanup
(crontab -l 2>/dev/null; echo "0 4 * * 0 docker system prune -f && docker builder prune -af") | crontab -
```

### One cause was mine

The original compose used `flyway/flyway` for migrations. That image bundles
JDBC drivers for Databricks, Snowflake, Oracle, DB2 and more — roughly **1 GB**
to run 17 Postgres files. The failed pull was literally on
`flyway/drivers/databricks-jdbc-2.6.38.jar`.

**That service is gone.** The backend now applies migrations itself at startup
(`src/db/migrate.ts`), reading the same `.sql` files and the same
`flyway_schema_history` table with Flyway's own CRC32 algorithm. No new image,
one fewer container.

---

## Stage 4 — First deploy (30 min)

Everything is already wired. Commit and push; the GitHub webhook triggers
Beachhead.

```bash
cd ~/workspace/gearline

# Migrations moved into the backend, which now owns them. The sandbox could not
# delete the old copy, so remove it yourself:
git rm -r --cached migrations 2>/dev/null; rm -rf migrations

git add -A
git commit -m "Replace Java backend with Node/Express; retire Redis and RabbitMQ"
git push
```

Confirm before pushing that `backend-node/migrations/` has all 17 `.sql` files
and the repo root no longer has a `migrations/` directory.

Watch the deployment log in the Beachhead dashboard. It should pass through:
`CLONING → ENV_INJECTION → BUILDING → STARTING_CONTAINERS → PROXY_SETUP →
VERIFY_HEALTH → SUCCESS`.

### Then check the backend log for these lines

```
Schema is up to date                    alreadyApplied: 17   latest: "17"
Database connection verified            schemaVersion: "17"
JWT signing configured                  algorithm: "HS512"   secretBytes: 64
Credential encryption enabled (AES-256-GCM)
Job queue started                       queue: "gearline.sync.jobs"
Gearline backend listening              port: 3001
```

**Check each one:**

| Line | If it's wrong |
|---|---|
| `Schema is up to date … 17` | Should say **up to date**, applying nothing — your database is already at V17. If it says "Applying pending migrations", it did not recognise the existing history. **Stop and tell me.** |
| `schemaVersion: "17"` | As above. |
| `algorithm` | Must be `HS512` (confirmed in Stage 3). If not, `JWT_SECRET` differs between the dashboard and the container. |
| `Credential encryption enabled` | If it warns the key is not set, `CREDENTIAL_ENCRYPTION_KEY` isn't reaching the container — check it's a **global** var with no Target Service. |
| `Job queue started` | pg-boss couldn't create its schema. Check DB permissions. |

**STOP if:** any line is missing or wrong.

### About checksum warnings

You may see lines like:

```
Checksum differs from the recorded value   version: "3"  appliedChecksum: ...  fileChecksum: ...
```

**This is a warning, not a failure, and it is safe.** Those migrations already
ran and are skipped by version — nothing is re-executed. It only means my CRC32
reimplementation disagrees with the Flyway build that wrote the row.

To check whether they actually line up, compare against what I computed from
your files:

```sql
SELECT version, script, checksum FROM flyway_schema_history ORDER BY installed_rank;
```

| V | Expected checksum |
|---|---|
| 1 | -198003662 |
| 2 | 823920888 |
| 3 | -674746911 |
| 4 | -1645537891 |
| 5 | -500458098 |
| 6 | -1961855221 |
| 7 | -96398385 |
| 8 | 2056835521 |
| 9 | -676571716 |
| 10 | 2130581263 |
| 11 | 1192513754 |
| 12 | 1670038623 |
| 13 | -1089067369 |
| 14 | 655725807 |
| 15 | 673245316 |
| 16 | 1136298079 |
| 17 | -836236373 |

If they all match, set `MIGRATE_STRICT_CHECKSUM=true` in the dashboard to turn
future mismatches into hard failures — at that point a mismatch really would
mean someone edited an applied migration.

### Rollback for this stage

In `frontend/nginx.conf`, change the `/api/` and `/webhooks/` blocks back to
`http://backend:8080`, re-add the Java `backend:` service to
`docker-compose.yml`, push. ~2 minutes.

---

## Stage 5 — Smoke test (30 min)

Do these **in order** — each depends on the last.

### 5a. Auth

- [ ] Open the dashboard in a **private window**. Log in.
- [ ] Reload — you should stay logged in.
- [ ] In your **normal** window (which has an old token from the Java service),
      reload. You should also stay logged in. *This proves token compatibility.*

**STOP if:** the old token is rejected. `JWT_SECRET` mismatch.

### 5b. Reads

- [ ] **Products** — list loads, search works, sort by price works
- [ ] **Products** — click into one, fields populate
- [ ] **Orders**, **Listings**, **Sync Activity**, **Audit Logs** — all load and paginate
- [ ] **Dashboard** — tile counts look right

Pagination is the one to watch: it proves the Spring `Page<T>` envelope is
reproduced correctly. If tables render but are empty, that's the cause.

### 5c. Writes

- [ ] Edit a product's title → save → reload → change persisted
- [ ] Create a pricing profile with an awkward percentage like `33.3333`
- [ ] Assign it to an account, then check a listing's computed price

### 5d. Marketplace connectivity

- [ ] **Marketplaces** → Health Check on each account → all report healthy
- [ ] Reverb account → shipping profiles dropdown populates
- [ ] eBay account → locations / fulfilment / return policy dropdowns populate

**STOP if:** health checks fail. Check `connection_status` and `last_error` on
`marketplace_accounts`.

### 5e. Webhooks

In Shopify admin → **Settings → Notifications → Webhooks**, check recent
deliveries are returning **200**.

Then, to test live:

- [ ] Change a product's title in Shopify
- [ ] Within a few seconds it should update in Gearline

**STOP if:** webhooks return 401. That's an HMAC failure —
`SHOPIFY_CLIENT_SECRET` is wrong or missing.

### 5f. eBay notifications

```bash
curl https://<your-domain>/api/v1/marketplace/ebay/notifications/debug
```

Compare `endpointUrl` **character for character** with what's registered in the
eBay Developer Portal. A trailing slash or `http` vs `https` breaks the hash.

Then click **Send Test Notification** in the portal — it should verify.

**STOP if:** verification fails. Left unresolved, eBay disables your keyset.

---

## Stage 5.5 — Two Reverb issues found in the first production log

Both surfaced on the first real poll and are now fixed. Redeploy to pick them up.

### 1. Reverb ignores `created_after`

A poll with a 7-minute window returned **321 orders across 7 pages**, the oldest
several years old — the complete order history, every 10 minutes. Deduplication
caught them all (`imported: 0, failed: 0`), so no bad data, but it burned 7 API
calls and ~26 seconds per cycle and would eventually hit Reverb's rate limits.

Rather than guess at the right parameter name or date format, the connector now
filters **client-side**, which is correct whether or not Reverb honours the
filter:

- Stops paginating once an entire page is older than the watermark (Reverb
  returns newest-first; checking a whole page rather than one order keeps it
  safe if ordering is ever less strict)
- Filters mapped results by `createdAt` as a backstop
- Unparseable or missing dates are **kept**, so a date-format change degrades to
  the old behaviour rather than silently dropping orders

**Effect: 1,008 list calls/day → 144.**

### 2. Reverb list orders have no line items — inventory would not deduct

Every one of the 321 orders logged *"no listing object — line items empty"*.
Reverb's LIST endpoint omits the nested `listing` object; only the single-order
GET includes it.

That means a genuinely new Reverb order would have imported with **no line
items → no SKU → no inventory deduction**. Silent, and only visible as stock
drifting out of sync.

The Java service had the identical code path, so this is **pre-existing, not a
regression** — the port simply made it visible by logging it.

Fixed: each order that survives the date filter is re-fetched individually for
its line items (normally 0–2 calls per poll). If the detail *still* has no line
items, the order is **skipped rather than imported**, because importing it
without a SKU means silently missing the inventory change. The scheduler does
not advance `lastSyncAt` on failure, so it retries next cycle.

The per-order log line dropped from WARN to DEBUG — it is the normal case for
the list endpoint, and at WARN it produced ~46,000 lines a day on a disk you had
just cleared.

**Verify after redeploying:** the next poll should log roughly

```
Fetched Reverb orders   scanned: 50   recent: 0   pages: 1   stoppedEarly: true
```

instead of `count: 321, pages: 7`.

---

## Stage 6 — The Reverb inventory question (15 min)

This is the open item I flagged. Your Java code contradicts itself: listing
creation sends `inventory` as a flat integer, inventory sync sends it nested as
`{ inventory: { total: n } }`. The mapper's own comment says flat is correct.

**Test it:**

1. Publish a product to Reverb (or pick one already live)
2. Note its quantity on Reverb
3. Change the quantity in Shopify (or trigger an inventory sync in Gearline)
4. Check Reverb again

**If the quantity did NOT change**, the nested form is wrong and inventory sync
has never worked. Fix:

```ts
// backend-node/src/marketplace/reverb/client.ts, in updateInventory()
json: { has_inventory: true, inventory: quantity },   // was: { inventory: { total: quantity } }
```

Tell me either way and I'll make the change properly with a test.

---

## Stage 7 — Delete the Java service (5 min)

**Only after Stages 4–6 have all passed**, and ideally after a week of normal use.

```bash
cd ~/workspace/gearline
git rm -r backend/
git commit -m "Remove retired Java backend"
git push
```

Then in the Beachhead dashboard, delete these now-unused variables:

- `RABBITMQ_PASSWORD`
- any `SPRING_RABBITMQ_*`
- any `SPRING_REDIS_*`
- any `SPRING_DATASOURCE_*`

Finally, confirm the container count on the VM:

```bash
docker ps --format '{{.Names}}'
```

You should see **three** long-running containers (postgres, backend, frontend)
plus a completed `flyway` one-shot. Memory should be roughly 350 MB, down from
about 1.1 GB.

---

## If something breaks later

**Roll back one route.** Add a more specific `location` block above the
catch-alls in `frontend/nginx.conf`:

```nginx
location ~ ^/api/v1/products/[^/]+/resync-from-shopify$ {
    set $upstream http://backend-java:8080;
    include /etc/nginx/proxy-common.conf;
}
```

nginx evaluates regex before plain prefixes and `^~` before regex, so a
targeted block always wins. This only works while the Java service is still
deployed — which is why Stage 7 waits.

**Sync jobs stuck in QUEUED.** Check the backend log for
`No connector registered`. Otherwise replay them from the Sync Activity page.

**A listing shows FAILED after a delist.** Expected behaviour: the delist
exhausted its retries and the listing may still be live on the marketplace.
Check Seller Hub / Reverb directly.

**An order is SHIPPED in Shopify but not on the marketplace.** Also expected:
the notification failed, so tracking was saved but the status deliberately was
not advanced. `orders.tracking_number` will be populated while `order_status`
is not `SHIPPED`.

---

## Known open items

| Item | Impact | When |
|---|---|---|
| Reverb inventory flat-vs-nested | Inventory sync may not work | Stage 6 |
| `REVERB_CLIENT_ID` / `_SECRET` are **empty** | Reverb OAuth cannot run | See below |
| No integration tests | Schema mapping unproven by a real DB | After cutover |
| No load testing | Pool size (10) and queue concurrency (5) are reasoned, not measured | When traffic grows |
| Marketplace field names | Taken from Java source + docs, not live responses | Stage 5d–5e covers most |

### About the empty Reverb credentials

`REVERB_CLIENT_ID` and `REVERB_CLIENT_SECRET` are both blank in the dashboard.

That is fine **if** your Reverb account was connected with a personal access
token via `POST /api/v1/marketplace/accounts` rather than the OAuth flow — which
is what that endpoint exists for, and the empty values suggest is the case.

The consequence to know about: with no client credentials, **token refresh
cannot work**. `refreshAccessToken` will call Reverb's token endpoint with an
empty `client_id`, fail, and mark the account `TOKEN_EXPIRED`.

- A PAT does not expire, so there is nothing to refresh — no problem.
- An OAuth token *does* expire, and you would find out only when it lapsed.

Check which you have:

```sql
SELECT display_name, connection_status, last_sync_at
FROM marketplace_accounts WHERE marketplace_type = 'REVERB';
```

Then confirm in Stage 5d that the Reverb health check passes. If it does, the
stored token works and this is a non-issue. If you *are* on OAuth, fill in both
variables before the token's next expiry.
