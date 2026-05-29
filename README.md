# Gearline

Headless marketplace orchestration platform for music retailers.  
Synchronizes inventory, listings, and orders between Shopify and external marketplaces (Reverb, eBay).

---

## Deployment

Gearline is hosted on Beachhead. There is nothing to run locally — Beachhead pulls the repository, builds the Docker images, and manages all services. You configure the application entirely through the Beachhead dashboard.

### 1. Set environment variables in the Beachhead dashboard

Go to your app's **Settings → Environment Variables** and add each of the following as a **global** variable (no Target Service). Beachhead writes these to `.env` so Docker Compose can substitute them at startup.

| Variable | Description |
|---|---|
| `DB_PASSWORD` | PostgreSQL password |
| `RABBITMQ_PASSWORD` | RabbitMQ password |
| `JWT_SECRET` | Random string, minimum 64 characters |
| `APP_BASE_URL` | Your public domain, e.g. `https://gearline.example.com` |
| `SHOPIFY_CLIENT_ID` | From your Shopify Partner app |
| `SHOPIFY_CLIENT_SECRET` | From your Shopify Partner app |
| `SHOPIFY_FLOW_SECRET` | Static token for Shopify Flows webhooks (optional — see [Connecting Shopify Flows](#connecting-shopify-flows)) |
| `SHOPIFY_FLOW_TOKEN_HEADER` | Header name for the Flows token (optional, default: `X-Shopify-Flow-Token`) |
| `REVERB_CLIENT_ID` | From your Reverb developer app |
| `REVERB_CLIENT_SECRET` | From your Reverb developer app |
| `EBAY_CLIENT_ID` | From your eBay developer app (optional) |
| `EBAY_CLIENT_SECRET` | From your eBay developer app (optional) |

### 2. Deploy

Push to your connected branch. Beachhead builds and deploys automatically. The `postgres` service is declared as a stateful service in `beachhead.json` — it runs under a stable project name and is never torn down during a blue-green swap, so your data persists across every deploy.

### 3. Access the application

Once deployed, the app is available at your Beachhead-assigned domain.

| Path | What it is |
|---|---|
| `/` | Gearline admin UI |
| `/api/v1/swagger-ui.html` | Interactive API docs |

### Default login

| Field | Value |
|---|---|
| Email | `admin@gearline.io` |
| Password | `GearlineAdmin1!` |

Change this immediately after first login. The seed is applied by migration `V8__seed_admin_user.sql` and runs once on first startup.

---

## What Beachhead manages

Beachhead handles everything at the infrastructure level. You do not interact with Docker Compose directly.

- Builds `backend/Dockerfile` and `frontend/Dockerfile` on each deploy
- Runs all five services defined in `docker-compose.yml`: `postgres`, `redis`, `rabbitmq`, `backend`, `frontend`
- Routes public HTTP traffic to the `frontend` service (port 80) via its nginx-proxy
- The frontend nginx container proxies `/api/` and `/webhooks/` to the `backend` service internally, using Docker's embedded DNS resolver so the proxy doesn't fail if the backend is slow to start
- Keeps `postgres` running continuously under a fixed project name — never recreated on redeploy
- Injects all global dashboard variables into `.env` before `docker compose up`

---

## Architecture

```
gearline/
├── beachhead.json              # public_service: frontend, stateful_services: [postgres]
├── docker-compose.yml          # All five services, internal network, named volume
│
├── backend/                    # Spring Boot 3, Java 21, Maven
│   ├── Dockerfile
│   └── src/main/java/com/gearline/
│       ├── api/                # REST controllers + DTOs
│       │   ├── auth/           # JWT login / refresh / me
│       │   ├── products/       # Product CRUD
│       │   ├── listings/       # Publish / delist / overrides
│       │   ├── orders/         # Order imports
│       │   ├── marketplaces/   # Account management + health check
│       │   ├── sync/           # Sync job monitoring + replay
│       │   └── admin/          # Dashboard stats + audit logs
│       ├── config/             # Security, RabbitMQ, OpenAPI, properties
│       ├── domain/             # Core entities — no marketplace-specific fields
│       │   ├── product/
│       │   ├── marketplace/
│       │   ├── listing/
│       │   ├── order/
│       │   ├── sync/
│       │   ├── audit/
│       │   └── user/
│       ├── infrastructure/
│       │   ├── persistence/    # Spring Data JPA repositories
│       │   ├── messaging/      # RabbitMQ producer / consumer / message types
│       │   └── security/       # JWT filter + token service
│       ├── marketplace/
│       │   ├── common/         # MarketplaceConnector interfaces + shared DTOs
│       │   ├── shopify/        # Webhook receiver, HMAC validation, async processor
│       │   ├── reverb/         # Full reference implementation
│       │   │   ├── client/     # ReverbApiClient (WebClient)
│       │   │   ├── connector/  # ReverbConnector + ReverbAuthProvider
│       │   │   ├── dto/        # Reverb API response models
│       │   │   └── mapper/     # Listing mapper + order mapper
│       │   └── ebay/           # Interface stubs, OAuth skeleton
│       └── service/
│           ├── AuditService.java
│           ├── SyncDispatcherService.java
│           └── InventoryConsistencyService.java
│
└── frontend/                   # Vue 3 + Vite + Pinia + Tailwind
    ├── Dockerfile
    ├── nginx.conf              # Proxies /api/ and /webhooks/ to backend service
    └── src/
        ├── views/              # Login, Dashboard, Products, Listings, Orders,
        │                       # Marketplaces, Sync Activity, Audit Logs, Settings
        ├── layouts/            # AppLayout (sidebar nav + user footer)
        ├── stores/             # Pinia auth store (access + refresh tokens)
        ├── router/             # Vue Router with auth guards
        ├── lib/                # Axios with automatic JWT refresh interceptor
        └── components/
```

---

## Key Design Decisions

**Shopify is the source of truth.** Inventory webhooks from Shopify trigger sync jobs that propagate quantity changes to all other connected marketplace listings. The `Product` entity stores `shopifyProductId` for traceability but Gearline maintains its own canonical catalog — Shopify is the input, not the owner.

**Marketplace isolation is strict.** No marketplace-specific fields live on `Product`. Everything channel-specific (external listing IDs, pricing overrides, category mappings, raw API metadata) lives on `MarketplaceListing`. Adding a new marketplace means implementing the `MarketplaceConnector` interface and annotating it `@Component` — no changes elsewhere.

**Oversell prevention.** `Product` carries a JPA `@Version` column for optimistic locking. `InventoryConsistencyService` is annotated `@Retryable` to transparently retry on concurrent version conflicts. When any order lands, quantity is decremented and propagated to all active listings before the job completes.

**Async by default.** All marketplace operations are enqueued to RabbitMQ and processed by `SyncJobConsumer`. Failed jobs retry with exponential backoff. After exhausting retries they route to the dead-letter queue. Every job is persisted to the `sync_jobs` table so failures are visible in the UI and can be replayed.

**Immutable audit trail.** Every significant platform action writes an `AuditEvent` in a `REQUIRES_NEW` transaction, so audit records survive even if the surrounding operation rolls back.

---

## Connecting Shopify

1. Create a Shopify Partner app at `partners.shopify.com`
2. Add `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` to the Beachhead dashboard
3. In the Shopify app config, register these webhooks pointing at your deployed domain:

| Topic | URL |
|---|---|
| `inventory_levels/update` | `https://your-domain/webhooks/shopify/inventory-levels/update` |
| `products/update` | `https://your-domain/webhooks/shopify/products/update` |
| `products/create` | `https://your-domain/webhooks/shopify/products/create` |
| `orders/create` | `https://your-domain/webhooks/shopify/orders/create` |

Gearline validates the `X-Shopify-Hmac-Sha256` header on every inbound webhook. Requests with invalid signatures are rejected with 401 and recorded in the audit log.

### Manual publish gate

Marketplace publishing is **intentionally not automatic**. When Shopify signals that a product was created or updated, Gearline:

1. Upserts the local product record with the latest data from Shopify.
2. Creates a listing row in **NEEDS_REVIEW** status for every connected marketplace account (Reverb, eBay, etc.).

These pending listings appear in a review queue on the dashboard home page. Before anything is sent to a marketplace, you review the listing, configure channel-specific overrides (category, shipping profile, model/year, etc.) via the Listings page, and then click **Publish**. Only at that point does the job enter the queue.

Inventory quantity changes (`inventory_levels/update`) and order imports (`orders/create`) are still processed automatically — no review step.

---

## Connecting Shopify Flows

Shopify Flows is a no-code automation tool available on Shopify Plus. Its "Send HTTP Request" action can call Gearline but does **not** use the standard HMAC signature scheme — instead you configure a static secret token.

1. Choose a secret token string (e.g. a random UUID) and add it to Beachhead as `SHOPIFY_FLOW_SECRET`.
2. In your Flow's "Send HTTP Request" action, configure:

| Setting | Value |
|---|---|
| URL | `https://your-domain/webhooks/shopify/flows` |
| Method | `POST` |
| Header name | `X-Shopify-Flow-Token` (or your custom name — set `SHOPIFY_FLOW_TOKEN_HEADER` to match) |
| Header value | The same value as `SHOPIFY_FLOW_SECRET` |
| Body | JSON template — include at minimum `shopify_product_id: {{product.id}}` |

Gearline uses constant-time comparison on the token to prevent timing attacks. If the token is missing or wrong the request is rejected with 401 and recorded in the audit log.

A minimal Flow body that triggers the review queue:

```json
{
  "topic": "product_activated",
  "shop_domain": "mystore.myshopify.com",
  "shopify_product_id": "{{product.id}}",
  "title": "{{product.title}}",
  "vendor": "{{product.vendor}}",
  "sku": "{{product.variants.first.sku}}",
  "price": "{{product.variants.first.price}}"
}
```

---

## Connecting Reverb

1. Create a developer app at `reverb.com/my/selling/developer`
2. Add `REVERB_CLIENT_ID` and `REVERB_CLIENT_SECRET` to the Beachhead dashboard
3. Use the OAuth authorization flow to connect an account — Gearline will store and automatically refresh tokens
4. Once connected, `ReverbConnector` handles listing creation, inventory updates, and order imports

---

## API Reference

Full interactive docs: `https://your-domain/api/v1/swagger-ui.html`

```
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
GET    /api/v1/auth/me

GET    /api/v1/products
POST   /api/v1/products
GET    /api/v1/products/{id}
PUT    /api/v1/products/{id}

GET    /api/v1/listings
GET    /api/v1/listings/product/{productId}
POST   /api/v1/listings/{id}/publish
POST   /api/v1/listings/{id}/delist
PATCH  /api/v1/listings/{id}/overrides

GET    /api/v1/orders

GET    /api/v1/marketplace/accounts
POST   /api/v1/marketplace/accounts/{id}/health-check
PATCH  /api/v1/marketplace/accounts/{id}/toggle

GET    /api/v1/sync/jobs
POST   /api/v1/sync/jobs/{id}/replay
POST   /api/v1/sync/jobs/{id}/cancel

GET    /api/v1/audit

GET    /api/v1/admin/dashboard/stats

POST   /webhooks/shopify/inventory-levels/update
POST   /webhooks/shopify/products/update
POST   /webhooks/shopify/products/create
POST   /webhooks/shopify/orders/create
```
