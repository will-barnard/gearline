# Gearline: Java → Node/Express migration

How the swap works, what's done, what isn't, and the exact steps to cut over on
Beachhead.

---

## The short version

Both backends run at once against the same Postgres database. nginx decides,
per API path, which one serves it. Moving a route across is a one-line change;
rolling it back is the same line. There is never a moment where the whole
system is on new code and you're hoping.

```
                 ┌──────────────┐
   browser  ───► │   frontend   │  (nginx — the router)
                 └──────┬───────┘
                        │
          ┌─────────────┴──────────────┐
          ▼                            ▼
   ┌─────────────┐             ┌───────────────┐
   │   backend   │             │  backend-node │
   │ Java :8080  │             │  Node :3001   │
   └──────┬──────┘             └───────┬───────┘
          │                            │
          │  ┌──────────────────┐      │
          └─►│    postgres      │◄─────┘
             │  (shared, one DB)│
             └──────────────────┘
          │
          ├─► redis      ─┐  Java only.
          └─► rabbitmq   ─┘  Deleted in step 6.
```

**Flyway in the Java service stays the sole owner of the schema.** The Node
service verifies the schema version at boot and never migrates. That's what
makes it safe for both to share one database.

---

## Why this addresses your actual problem

You said Java is cumbersome on the VM for both build and runtime. Those are two
different problems with two different fixes:

**Runtime** — Spring Boot idles around 400–500 MB RSS. Node idles around 80 MB.
Dropping RabbitMQ (~150 MB) and Redis (~30 MB) on top of that is the bigger win:
you go from five containers to three.

**Build** — this is fixable *today*, independently of the rewrite, and you should
do it either way. Your current `backend/Dockerfile` runs Maven inside the build,
resolving dependencies and compiling on the VM every deploy. Even with
`MAVEN_OPTS=-Xmx512m` that's the heaviest thing your VM does. Two options:

- Build the JAR in GitHub Actions, push the image to a registry, have Beachhead
  pull it. Beachhead already supports remote build workers.
- Or, right now: `BEACHHEAD_BUILD_PLATFORM=linux/amd64` is set on Will's worker,
  so remote builds are already viable for this repo.

Don't wait for the rewrite to fix the build. It's a separate, smaller job.

---

## What's actually been ported

### Done and in the repo

| Area | Notes |
|---|---|
| Scaffold | TypeScript, Express 4, Kysely, pino, graceful shutdown |
| JWT | Wire-compatible, **algorithm derived from secret length** (see below) |
| Passwords | bcrypt cost 12, `$2a$` — round-trips with Spring Security both ways |
| Credential encryption | AES-256-GCM, byte-identical wire format to Java |
| Auth middleware | Incl. the global "all DELETEs are ADMIN-only" rule |
| Error handling | RFC 7807 ProblemDetail, same statuses as `GlobalExceptionHandler` |
| Pagination | Spring Data `Page<T>` envelope reproduced exactly |
| Products | List/filter/sort, get, create, update, archive, CSV export, exclusion, bulk exclusion |
| Listings | List, get, by-product, create, publish, delist, dismiss, overrides |
| Orders | List, get |
| Pricing profiles | Full CRUD, exact BigDecimal-equivalent maths |
| Sync jobs | List, get, replay, cancel, bulk cancel |
| Marketplace accounts | List, get, toggle, pricing profile, settings |
| Admin | Users CRUD, password reset, dashboard stats, audit log |
| Queue | pg-boss replacing RabbitMQ, retry scheduler preserved |
| Bootstrap admin | `DataInitializer` equivalent, idempotent |
| Deployment | Dockerfile, compose, strangler nginx, all Beachhead rules checked |

### Orchestration layer — also done

| Component | Notes |
|---|---|
| Connector interfaces + registry | `MarketplaceConnector` contract, explicit registration |
| `ListingAttributeResolver` | Override arbitration, eBay account defaults, description suffix |
| `SyncDispatcherService` | All five job handlers, pricing-profile application |
| Sync job consumer | pg-boss consumer with the Java retry/dead-letter semantics |
| `InventoryConsistencyService` | Cross-channel propagation, hand-written optimistic locking |
| `OrderImportService` | Dedup → persist → deduct → (Shopify push pending) |

### Not ported — the three connectors

**~8,400 lines** of marketplace integration remain in Java:

- `ShopifyWebhookProcessor` (785) — inventory/order/product webhooks
- `EbayConnector` + `EbayApiClient` (1,004) — Inventory API, offers, policies
- `ShopifyResyncService` (501) — incl. atomic SKU-collision resolution
- `ReverbConnector` + client + mappers (~900)
- Three OAuth flows, eBay GDPR notifications, `ShopifyOrderPushService`

I stopped at the connector boundary deliberately. This code publishes live
listings, moves inventory, and imports orders with money attached. A field-
mapping divergence in the eBay mapper doesn't throw — it quietly publishes a
wrong price or condition and you hear about it from a customer.

Node routes for these paths return **501 with an explanatory message** rather
than 404, so a routing mistake is obvious instead of looking like a frontend bug.

---

## Deprecating Java completely

The connector port is the only thing standing between you and deleting
`backend/`. Ordered by dependency, with the reasoning for the sequence:

### Phase A — Reverb — **DONE**

Ported and registered. `src/marketplace/reverb/` contains the client, auth
provider, connector, listing mapper and order mapper; `src/marketplace/http.ts`
is the shared request helper that replaces WebClient and classifies errors as
retryable vs permanent.

31 mapper behaviours verified by execution (see `test/reverb-mappers.test.ts`),
including the ones most likely to break silently: flat vs nested inventory,
photos as plain strings, the make/model required-field cascade, all-or-nothing
dimensions, and the numeric `order_id` coercion.

**Two things to verify against a real Reverb account before trusting it:**

1. **The nested/flat inventory inconsistency, carried over from Java.**
   `createListing` sends `{ has_inventory: true, inventory: 3 }` (flat), but
   `updateInventory` sends `{ inventory: { total: 3 } }` (nested). Those
   disagree, and `ReverbListingMapper`'s own comment says the flat form is
   correct — "NOT a nested object". So the nested form on the update path is
   suspect, and **inventory sync to Reverb may never have actually worked.**

   I reproduced it faithfully rather than "fixing" it, because changing it is a
   behavioural change that needs verifying against a live listing, not a guess
   made mid-port. Test it: set a Reverb listing to a known quantity, trigger an
   inventory sync, and check whether the quantity actually moves. If it doesn't,
   switch `updateInventory` to the flat form.

2. **Token refresh.** Reverb rotates refresh tokens on use. Confirm a refresh
   cycle completes and the new token persists — force it by setting
   `expires_at` in the past on a test account.

### Phase A.5 — the partial-port guard

There is ONE job queue for all marketplaces, so registering Reverb starts the
consumer for **every** marketplace's jobs, including ones still owned by Java.

`sync-job-consumer.ts` handles this: if no connector is registered for a job's
marketplace, it leaves the row `QUEUED` and acknowledges the message rather than
dead-lettering it. The job stays visible and replayable, and becomes processable
the moment its connector lands.

Consequence for routing: you can now move Reverb listing publish/delist to Node,
but **anything that enqueues Shopify or eBay work should stay on Java** until
those connectors are ported — otherwise the jobs pile up as `QUEUED` in Node's
pg-boss while Java never sees them.

### Phase B — Shopify — **PARTIALLY DONE**

Done and registered:

| Component | Notes |
|---|---|
| `client.ts` | Admin REST, per-store base URL, Link-header cursor pagination |
| `connector.ts` | Mostly no-ops by design — Shopify is the product source |
| `order-mapper.ts` | Order mirror body, incl. `inventory_behaviour: bypass` |
| `order-push.ts` | Closes the gap that was flagged in `order-import.ts` |
| `webhook-validator.ts` | HMAC-SHA256 over the raw body, constant-time compare |
| `webhook-processor.ts` | All five topics: inventory, product create/update, orders, fulfilments |
| `routes/webhooks.ts` | Validate → 200 immediately → process detached |

HMAC verified by execution, including the case that proves the raw-body
requirement: a re-serialised body **fails** its original signature. That is the
single most common way a Java→Node webhook port breaks, and it fails closed.

Also now done:

| Component | Notes |
|---|---|
| `oauth.ts` + `routes/shopify-oauth.ts` | Install + callback, HMAC and nonce verified |
| `initial-sync.ts` | Bulk catalogue import, reuses the webhook path |
| `services/fulfillment-notification.ts` | Reverb wired; eBay throws by design |

The OAuth HMAC is a **different scheme** from the webhook one — hex over the
sorted query string, versus Base64 over the raw body. Both verified by
execution, including that a Base64 signature is rejected on the hex path and
that URL-decoding first would break validation.

`/api/v1/marketplace/shopify/oauth/`, `health-check`, `sync-products` and
`reverb/shipping-profiles` have now been moved to Node in `nginx.conf`.
All 25 routes re-verified against nginx's matching algorithm.

**Still on Java (task #19):**

- `ShopifyResyncService` (501 lines) — the atomic `RESYNC-TEMP-` SKU-collision
  algorithm. Port with tests before pointing traffic at it; a bug here can
  scramble SKUs across the whole catalogue.
- Flow action handlers
- `ListingBackfillService` — which is why account creation (`POST
  /marketplace/accounts`) also stays on Java; creating an account in Node would
  connect the marketplace but silently skip backfilling NEEDS_REVIEW stubs.

**`/webhooks/` must stay on Java until eBay is ported.** The Shopify processor
itself is done and its HMAC is verified, but `fulfillment-notification.ts`
deliberately throws for eBay orders. That path saves tracking and leaves the
order unshipped — correct fail-safe behaviour, but it means eBay buyers would
stop receiving tracking numbers if you cut over early.

**Moving Shopify OAuth: do it during a quiet period.** Nonces are in-memory and
per-process, so an install that is mid-handshake when the upstream changes will
fail its nonce check and has to be restarted. Same applies to any Beachhead
blue/green swap.

**Two oddities found while porting, worth a look:**

1. **Shopify `orders/create` may be dead code.** The webhook enqueues an
   `ORDER_IMPORT` job with `marketplaceType: SHOPIFY`, but
   `ShopifyConnector.importOrder` returns null, so the dispatcher logs
   "connector returned null — skipping". Shopify orders therefore never reach
   the `orders` table. That may well be intentional (Shopify is already the
   system of record; Gearline imports *into* it, not from it) — but if so the
   job enqueue is pointless work. Faithfully reproduced either way.

2. **`isValidSignature` fails OPEN when `SHOPIFY_CLIENT_SECRET` is blank.**
   Inherited from Java and kept for dev parity, but it means a missing secret in
   production accepts every unsigned webhook. Worth asserting the variable is
   set at boot.

### Phase C — eBay — **DONE**

| Component | Notes |
|---|---|
| `client.ts` | Inventory, Fulfillment, Account and Taxonomy APIs |
| `auth-provider.ts` | OAuth with the RuName quirk, Basic auth, scoped refresh |
| `listing-mapper.ts` | Inventory-item and offer bodies, condition mapping |
| `order-mapper.ts` | Deeply-nested Fulfillment API order → ImportedOrder |
| `connector.ts` | Three-step publish, read-modify-write inventory sync |
| `routes/ebay.ts` | OAuth + GDPR account-deletion notifications |

Challenge hash verified: 64-char hex over
`challengeCode || verificationToken || endpointUrl` with no delimiter, proven
equivalent to eBay's incremental-digest sample. Also confirmed that a trailing
slash, http-vs-https, or any host difference changes the hash.

**Generating the verification token:** it must be 32–80 chars, alphanumeric plus
`_` and `-` only. `openssl rand -base64` produces `+`, `/` and `=`, which eBay
**rejects**. Use:

```bash
LC_ALL=C tr -dc 'a-zA-Z0-9_-' </dev/urandom | head -c 64
```

If verification fails, hit `/api/v1/marketplace/ebay/notifications/debug` — it
returns the exact endpoint URL being hashed, which is almost always the problem.

### Phase C.5 — the last services — **DONE**

| Component | Notes |
|---|---|
| `services/order-polling.ts` | Reverb + eBay polling, first-run guard, 72h cap |
| `services/listing-backfill.ts` | NEEDS_REVIEW stubs on new account connect |
| `marketplace/shopify/resync.ts` | Single + bulk SKU reconciliation |
| Flow webhook handler | With one deliberate bug fix — see below |

The SKU-collision algorithm was verified by simulation against an in-memory
store with a real unique constraint: two-product swaps, three- and five-way
rotations, blockers (archived products holding a needed SKU), idempotent
no-op runs, and local-only products. The naive one-at-a-time approach fails
every swap case; the two-pass approach resolves all of them.

### Current routing state

**Everything is on Node. 40 of 40 API and webhook routes verified.**

`nginx.conf` has been collapsed to route all `/api/` and `/webhooks/` traffic to
`backend-node:3001`. The Java service is no longer receiving any traffic.

**Keep it deployed anyway for a week or two.** Rolling a single route back is
then a four-line nginx block — the file has a worked example at the top.

---

## Two bugs found in the Java code while porting

Both are reproduced faithfully EXCEPT where noted.

### 1. Flow webhooks could zero out a product's price — FIXED, not reproduced

`ShopifyFlowWebhookController.buildSyntheticProductPayload` defaulted missing
fields:

```java
variant.put("price", flowPayload.path("price").asText("0.00"));
variant.put("inventory_quantity", ... .asInt(0));
```

Those defaults flow into the product upsert, which writes any non-blank value.
`"0.00"` is not blank. So **a Flow that sends only a product ID — the common
case — would overwrite that product's real price with $0.00 and its quantity
with 0**, and the processor would then enqueue `LISTING_UPDATE` jobs pushing
that $0.00 to every live marketplace listing.

The Node version forwards only the fields the Flow actually supplied. Omitted
fields stay omitted and the existing values survive. This is a deliberate
behavioural deviation; the original was destructive.

### 2. Reverb inventory sync may never have worked

`createListing` sends `inventory` as a flat integer;
`updateInventory` sends it nested as `{ inventory: { total: n } }`. These
contradict, and `ReverbListingMapper`'s own comment says the flat form is
correct — *"NOT a nested object"*.

Reproduced as-is, because changing it needs verification against a live Reverb
listing rather than a guess. **Test this before going live:** set a Reverb
listing to a known quantity, trigger an inventory sync, and check whether the
quantity actually moves. If not, switch `updateInventory` to the flat form.

### 3. Shopify `orders/create` appears to be dead code

The webhook enqueues an `ORDER_IMPORT` job, but `ShopifyConnector.importOrder`
returns null, so the dispatcher logs "connector returned null — skipping".
Shopify orders never reach the `orders` table.

Probably intentional (Shopify is already the system of record) — but if so the
enqueue is wasted work on every order. Reproduced as-is.

---

## Phase D — retiring Java — **MOSTLY DONE**

### Already applied to the repo

| Step | State |
|---|---|
| Migrations moved to `./migrations/` | Done — all 17 `.sql` files copied |
| Flyway one-shot container added | Done — `backend` waits on `service_completed_successfully` |
| Java `backend:` service removed from compose | Done |
| `redis` and `rabbitmq` removed | Done |
| `backend-node` renamed to `backend` | Done — compose and all 6 nginx upstreams |
| `DATABASE_URL` used directly | Done — JDBC fallback retained deliberately |
| `.env.example` rewritten | Done — dead vars listed for dashboard cleanup |

Re-verified against the Beachhead hard rules: `beachhead.json` at root, no
`version:`, no `container_name:`, `expose:` only, every service on
`networks: [internal]`, fixed volume name, postgres `start_period: 30s`,
explicit `context:` + `dockerfile:`, `npm install` not `npm ci`.

**Flyway keeps owning the schema.** These are the same `.sql` files, so
`flyway_schema_history` carries over untouched and an existing database resumes
from V17 rather than replaying. `baselineOnMigrate=false` is set deliberately —
if the history table is somehow missing, the deploy should fail loudly rather
than silently baselining and skipping every migration.

### The one step left for you

The `backend/` directory is **still on disk but no longer deployed**. Deleting
it is the last action, and it should wait until after a successful smoke test:

```bash
git rm -r backend/
```

I have deliberately not done this. Nothing in the Node service has been through
a compiler yet, and `backend/` is currently your only working implementation.
It costs nothing to keep for a week; it costs a lot to need it back after
deleting it.

### Beachhead dashboard cleanup

After the smoke test, delete: `RABBITMQ_PASSWORD`, and any `SPRING_RABBITMQ_*`,
`SPRING_REDIS_*`, `SPRING_DATASOURCE_*` entries.

### Result

**5 containers → 3** (postgres, backend, frontend), plus a one-shot flyway.
Estimated VM memory: **~1.1 GB → ~350 MB**.

---

## Verification status

### Compiles clean

`npm run typecheck` — **0 errors**.

The first run produced 96 errors, which came down to four root causes in the
type helpers plus two real bugs:

| Cause | Count | Fix |
|---|---|---|
| `Generated<Timestamp>` nesting | ~45 | Declared `GeneratedTimestamp` / `NullableTimestamp` directly. Wrapping `Generated<>` around a ColumnType alias does not reduce — the update type came back as the ColumnType itself, so every `.set({ updated_at })` failed. |
| JSONB write type | ~25 | `toJson()` now returns `RawBuilder<string>`, and the columns accept `string \| RawBuilder<string>`. |
| Untyped field bag | 14 | `extractProductFields` returns a typed `ProductFieldPatch` instead of `Record<string, unknown>`, which was widening every read to `{}`. |
| Date vs Timestamp in `where()` | 6 | Resolved by the timestamp fix. |
| **Real bug:** duplicate `const headers` | 2 | Renamed to `responseHeaders`. |
| **Real bug:** malformed error middleware | 1 | Typed as `ErrorRequestHandler`; Express identifies error handlers by arity and the `never` params broke the overload. |

Note `npm run typecheck` only covers `src/`. Use **`npm run typecheck:all`**
(or `npm run check`) to include `test/` — that gap is why the test files were
never checked on the first pass.

### Tests pass

44 assertions verified against the **compiled output**, covering:

- Money: pricing-profile percentages, HALF_UP on negatives, insurance tiers
- Reverb: flat inventory, plain-string photos, all-or-nothing dimensions,
  profile precedence, numeric `order_id` coercion, URL fallback, name splitting
- eBay: `USED_` condition prefixes, aspects as arrays, aspects NOT on the offer,
  package-type threshold, exact `lineTotal`, `lineItemId` retention
- Shopify: condition parsing including the unknown → null case

Plus, verified separately by execution:

- AES-256-GCM wire format (IV ‖ ciphertext ‖ tag), tamper detection
- Shopify webhook HMAC — including that a **re-serialised body fails** its
  original signature, which is what proves the raw-body handling
- Shopify OAuth HMAC (hex over sorted query) — and that a Base64 signature is
  rejected on that path
- eBay challenge hash, and that a trailing slash changes it
- SKU-collision algorithm: swaps, 3- and 5-way rotations, blockers

### Static checks

- All 65 files: every relative import resolves, every named import is exported
- No runtime import cycles, no unused imports
- nginx: all 40 API and webhook routes verified against nginx's real matching
  algorithm (`=` → `^~` → regex → longest prefix)

### What has NOT been verified

Be clear-eyed about this — everything above is static or unit-level:

1. **Never run against a real Postgres.** No query has actually executed. Column
   names, JSONB round-trips and the `ON CONFLICT` targets are checked against
   the schema by hand, not by the database.
2. **Never talked to a real marketplace API.** Every request body is built from
   the Java source and the API docs. Field names are the risk.
3. **No integration or route-level tests.** Would need a test database.
4. **No load testing.** The connection-pool sizing (10) and pg-boss concurrency
   (5) are reasoned, not measured.
5. **The Reverb inventory flat-vs-nested question is still open.**

Then, against a staging database:

1. `npx tsx scripts/verify-credentials.ts` — proves the Node code can decrypt
   what Java wrote. **If any row fails, stop.**
2. Check the boot log shows the expected JWT algorithm (`HS512` for a 64-char
   secret) and `Credential encryption enabled`.
3. Log in with an existing token, then a fresh login, then force a refresh.
4. `GET /api/v1/marketplace/ebay/notifications/debug` — confirm the endpoint URL
   matches the Developer Portal exactly.
5. Trigger one Shopify webhook and confirm it returns 200 and the product
   updates.
6. Publish one Reverb listing, then sync its inventory — this is the path with
   the flat-vs-nested question flagged above.

### Phase D — Retire Java

Once all three are registered and traffic has run through them for a week:

1. **Move Flyway ownership.** Node currently only reads
   `flyway_schema_history`. Either adopt a Node migration runner that continues
   the same version sequence, or keep the SQL files and run Flyway as a
   short-lived one-shot container in compose. The second is less work and keeps
   your existing migrations valid.
2. Point every nginx `set $upstream` line at `backend-node:3001`, delete the
   Java-specific location blocks, and collapse the file back to the simple
   `/api/` + `/webhooks/` form.
3. Delete the `backend/` directory and its compose service.
4. Delete `redis` and `rabbitmq` from compose; drop `SPRING_RABBITMQ_*`,
   `SPRING_REDIS_*` and `RABBITMQ_PASSWORD` from the Beachhead dashboard.
5. Rename `backend-node` → `backend` in compose and nginx.
6. Rename `SPRING_DATASOURCE_*` → `DATABASE_URL` and simplify `config.ts`.

**Result: 5 containers → 3.** Estimated VM memory: ~1.1 GB → ~350 MB.

### Effort

Rough, assuming focused sessions and testing against real marketplace accounts:

| Phase | Lines | Notes |
|---|---|---|
| A — Reverb | ~900 | Proves the pattern |
| B — Shopify | ~1,900 | Webhooks are the risk |
| C — eBay | ~1,400 | Largest surface |
| D — Retire | ~200 net deletion | Mostly deletion |

The Java service keeps working throughout. There is no deadline pressure and no
point at which the system is half-migrated and broken.

---

## Before you touch anything: two checks

### 1. Your JWT algorithm is probably HS512, not HS256

`JwtTokenService.signingKey()` reads:

```java
byte[] keyBytes = Decoders.BASE64.decode(
    Base64.getEncoder().encodeToString(secret.getBytes()));
return Keys.hmacShaKeyFor(keyBytes);
```

The Base64 encode immediately followed by a decode is a **no-op round trip** —
the key is just the raw UTF-8 bytes of `JWT_SECRET`. `Keys.hmacShaKeyFor()` then
picks the algorithm by key size:

| Secret length | Algorithm |
|---|---|
| 32–47 bytes | HS256 |
| 48–63 bytes | HS384 |
| **64+ bytes** | **HS512** |

Your `.env.example` recommends 64+ characters, so you're almost certainly on
HS512. The Node implementation derives this the same way, so it's handled — but
**check your actual secret's length** and confirm the log line at Node startup:

```
JWT signing configured (algorithm derived from secret length, matching jjwt)
    algorithm: "HS512"  secretBytes: 64
```

If that says HS256 and your Java service is on HS512, `JWT_SECRET` differs
between the two services. Fix that before proceeding or every user gets logged
out the moment a request lands on the other backend.

### 2. Verify credential decryption against real data

```bash
cd backend-node
CREDENTIAL_ENCRYPTION_KEY=<production key> \
SPRING_DATASOURCE_URL=jdbc:postgresql://localhost:5432/gearline \
SPRING_DATASOURCE_USERNAME=gearline \
SPRING_DATASOURCE_PASSWORD=<password> \
npx tsx scripts/verify-credentials.ts
```

This reads every `marketplace_accounts` row and confirms the Node code can
decrypt what Java wrote. It's read-only and never prints token values.

**If any row fails, stop.** Those accounts would lose their marketplace
connection. Almost always it's a `CREDENTIAL_ENCRYPTION_KEY` mismatch.

---

## The cutover

### Step 0 — Back up

```bash
docker exec <postgres-container> pg_dump -U gearline gearline | gzip > gearline-$(date +%F).sql.gz
```

Beachhead runs postgres as a `stateful_service`, so it survives deploys. This
backup is for the case where something writes bad data, which no deploy
mechanism protects you from.

### Step 1 — Deploy both backends, route nothing to Node

Edit `frontend/nginx.conf` and point every ported prefix back at Java:

```nginx
location ^~ /api/v1/auth/ { set $upstream http://backend:8080; ... }
```

Push. Beachhead builds and swaps. Nothing has changed behaviourally — you've
just proved the Node container builds, boots, connects to Postgres, and passes
its schema check.

Check the logs:

```
Database connection verified          schemaVersion: "17"
JWT signing configured                algorithm: "HS512"
Credential encryption enabled (AES-256-GCM)
Job queue started                     queue: "gearline.sync.jobs"
Gearline backend listening            port: 3001
```

### Step 2 — Move the safest route first

`/api/v1/audit` is read-only, low-traffic, and nothing depends on it. Flip it:

```nginx
location ^~ /api/v1/audit { set $upstream http://backend-node:3001; ... }
```

Push, then load the Audit Logs page. Check pagination, filters, timestamps.

**This is the real test of the Page envelope.** If the table renders and pages
correctly, the Spring Data `Page<T>` reproduction is right, and every other
paginated screen will work.

### Step 3 — Move the read-heavy routes

In this order, one deploy each, checking the corresponding screen:

1. `/api/v1/orders` — Orders page
2. `/api/v1/admin/dashboard` — Dashboard tiles (verify counts against Java first)
3. `/api/v1/listings` — Listings page
4. `/api/v1/products` — Products page, incl. search, sort, CSV export

For the dashboard, compare numbers before and after. The Node version collapses
eight COUNT queries into three; the numbers must be identical.

### Step 4 — Move auth

```nginx
location ^~ /api/v1/auth/ { set $upstream http://backend-node:3001; ... }
```

Highest-blast-radius step. Before pushing, confirm in a private window:

- Existing session still works (token issued by Java, validated by Node)
- Fresh login works
- Token refresh works — let an access token be rejected and watch the
  interceptor recover
- A deactivated user is refused

If sessions break, flip the line back and redeploy. Users who logged in during
the window keep working, because tokens are valid on both sides.

### Step 5 — Move the writes

`/api/v1/pricing-profiles`, `/api/v1/sync`, `/api/v1/admin/users`,
`/api/v1/marketplace/accounts`.

For pricing profiles specifically: create one with an awkward percentage
(`33.3333`), assign it, and confirm the computed price matches what Java
produced. `npm test` covers this, but confirm once with real data.

At this point Java serves only connectors, webhooks and OAuth.

### Step 6 — Port the connectors, then retire Java

Only after the above is stable. Order matters — dependencies first:

1. `ShippingCalculator`, `ListingAttributeResolver` (pure logic, testable)
2. `ShopifyApiClient`, `ReverbApiClient`, `EbayApiClient`
3. Connectors + mappers
4. `SyncDispatcherService` handlers, then the pg-boss consumer
5. Webhooks — **last**, and validate HMAC against real captured payloads
6. OAuth flows

When Java is gone, delete `redis` and `rabbitmq` from `docker-compose.yml`, drop
the `SPRING_RABBITMQ_*` / `SPRING_REDIS_*` env vars, and rename `backend-node`
to `backend` (updating `nginx.conf` to match).

Five containers → three.

---

## Rollback

Any single route: change its `set $upstream` line back to `http://backend:8080`
and push. Beachhead blue/greens, ~2 minutes.

Everything: point every line at `backend:8080`. The Java service has been
running untouched the whole time.

**What makes rollback safe:** the Node service adds no schema, no new
credential format, and no incompatible tokens. The one artefact it leaves behind
is the `pgboss` schema in Postgres, which the Java service ignores entirely.

**The one caveat:** jobs enqueued to pg-boss while Node was serving are not
visible to RabbitMQ. Rolling back after Node has processed sync jobs means
checking `sync_jobs` for rows stuck in `QUEUED` and replaying them from the Sync
Activity page.

---

## Beachhead specifics

Compose changes were checked against the skill's hard rules:

- `beachhead.json` at repo root, `postgres` declared `stateful_services`
- No `version:` key, no `container_name:`, no host `ports:` — `expose:` only
- Every service on `networks: [internal]` with a top-level `networks: {internal:}`
- `gearline-postgres` volume has a fixed `name:`
- Postgres healthcheck has `start_period: 30s`
- Every build block has explicit `context:` + `dockerfile:`
- Dockerfile uses `npm install`, not `npm ci`
- nginx uses the resolver + variable `proxy_pass` pattern with `ipv6=off`

**Env vars:** `backend-node` reuses the Spring variable names
(`SPRING_DATASOURCE_URL` etc.), converting the JDBC URL internally — so no new
dashboard entries are needed. `JWT_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` must
be **global** (no Target Service), since both services read them and compose
substitutes `${VAR}` only from `.env`.

`SHOPIFY_FLOW_SECRET` is referenced by the new service. If it isn't already a
global var in the dashboard, add it — otherwise it resolves to empty and Flow
token validation silently allows everything.

---

## Known gaps

Be aware of these:

1. **`npm install` was never run.** No registry access in the environment I built
   this in, so the code is **not typechecked**. Run `npm install && npm run
   typecheck` first — expect a handful of minor type errors, particularly around
   Kysely's `orderBy(db.dynamic.ref(...))` in `routes/products.ts`.

2. **The consumer exists but stays idle until a connector is registered.**
   `src/index.ts` only starts it when `registeredTypes().length > 0`. That guard
   is deliberate: with no connectors, every job it picked up would immediately
   dead-letter, converting a working system into a pile of failures. While idle,
   Java keeps consuming from RabbitMQ as it does today.

   Practical consequence: **don't route listing publish/delist to Node until
   Phase A lands.** Listing reads are fine. A job enqueued by Node before then
   goes into pg-boss and waits rather than failing — but Java won't see it,
   since Java reads RabbitMQ. Check `sync_jobs` for stuck `QUEUED` rows if you
   move a write route early.

   Same applies to `ORDER_IMPORT`: `order-import.ts` records the order and
   deducts inventory, but the Shopify mirror push is a Phase B item, so orders
   imported by Node would have a null `shopify_order_id`.

3. **Optimistic locking is partial.** `products.version` is respected on the
   marketplace-account settings write, but the product update path doesn't yet
   guard on it. Java's JPA `@Version` did this automatically. Low risk with one
   operator; worth closing before multi-user editing.

4. **No integration tests.** The unit tests cover decimal maths and crypto
   format. Route-level tests need a test database.

---

## Running locally

```bash
cd backend-node
npm install
npm run typecheck
npm test

SPRING_DATASOURCE_URL=jdbc:postgresql://localhost:5432/gearline \
SPRING_DATASOURCE_USERNAME=gearline \
SPRING_DATASOURCE_PASSWORD=gearline \
JWT_SECRET="<same as production>" \
npm run dev
```
