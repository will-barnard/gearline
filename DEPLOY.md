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

## Stage 4 — First deploy (30 min)

Everything is already wired. Commit and push; the GitHub webhook triggers
Beachhead.

```bash
cd ~/workspace/gearline

git add -A
git commit -m "Replace Java backend with Node/Express; retire Redis and RabbitMQ"
git push
```

Watch the deployment log in the Beachhead dashboard. It should pass through:
`CLONING → ENV_INJECTION → BUILDING → STARTING_CONTAINERS → PROXY_SETUP →
VERIFY_HEALTH → SUCCESS`.

### Then check the backend log for these five lines

```
Database connection verified            schemaVersion: "17"
JWT signing configured                  algorithm: "HS512"   secretBytes: 64
Credential encryption enabled (AES-256-GCM)
Job queue started                       queue: "gearline.sync.jobs"
Gearline backend listening              port: 3001
```

**Check each one:**

| Line | If it's wrong |
|---|---|
| `schemaVersion: "17"` | Flyway didn't run. Check the `flyway` container's log. |
| `algorithm` | Must match Stage 3. If not, `JWT_SECRET` differs between dashboard and what you measured. |
| `Credential encryption enabled` | If it says the key is not set, `CREDENTIAL_ENCRYPTION_KEY` isn't reaching the container — check it's a **global** var with no Target Service. |
| `Job queue started` | pg-boss couldn't create its schema. Check DB permissions. |

**STOP if:** any line is missing or wrong.

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
