import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';

import { logger } from './logger.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { authenticate, requireAdminForDelete, requireAuth } from './security/auth-middleware.js';
import { authRouter } from './routes/auth.js';
import { productsRouter } from './routes/products.js';
import { listingsRouter } from './routes/listings.js';
import { ordersRouter } from './routes/orders.js';
import { pricingProfilesRouter } from './routes/pricing-profiles.js';
import { syncRouter } from './routes/sync.js';
import { marketplaceAccountsRouter } from './routes/marketplace-accounts.js';
import { adminUsersRouter, auditRouter, dashboardRouter } from './routes/admin.js';
import { webhooksRouter } from './routes/webhooks.js';
import { shopifyOAuthRouter } from './routes/shopify-oauth.js';
import { ebayNotificationsRouter, ebayOAuthRouter } from './routes/ebay.js';

export function createApp(): Express {
  const app = express();

  /**
   * Behind nginx in every environment. Trusting the first proxy hop makes
   * req.ip the real client address rather than the container's gateway, which
   * matters for anything that logs or rate-limits by IP.
   */
  app.set('trust proxy', 1);

  // Do not advertise Express to the world.
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      // Health checks would otherwise dominate the log volume.
      autoLogging: {
        ignore: (req) => req.url === '/actuator/health' || req.url === '/health',
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      /**
       * ── Trimmed serialisers ────────────────────────────────────────────────
       *
       * pino-http's defaults serialise every request and response header. In
       * production that is ~1.5 KB per line, and eBay alone broadcasts roughly
       * 7,000 account-deletion notifications a day — about 14 MB/day, 5 GB/year,
       * on a VM that has already run out of disk once.
       *
       * These keep what is actually useful for debugging (method, path, status,
       * real client IP, user agent) and drop the rest. Full headers are still
       * available at debug level via the raw request if ever needed.
       *
       * The client IP comes from x-forwarded-for because every request arrives
       * through nginx; req.ip would otherwise be the container gateway.
       */
      serializers: {
        req(req) {
          const forwarded = req.headers['x-forwarded-for'];
          const clientIp =
            typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;

          return {
            id: req.id,
            method: req.method,
            url: req.url,
            ip: clientIp ?? req.remoteAddress,
            ua: req.headers['user-agent'],
          };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
      },
    }),
  );

  /**
   * ── Raw body capture, and why it must come before the JSON parser ──────────
   *
   * Shopify webhook HMACs are computed over the EXACT bytes Shopify sent. Once
   * express.json() has parsed and discarded the buffer, re-serialising the
   * object gives different bytes (key order, whitespace, unicode escaping) and
   * every signature check fails.
   *
   * The `verify` hook is the only place Express hands over the untouched buffer,
   * so we stash it on the request. Webhook handlers validate against
   * req.rawBody, never against JSON.stringify(req.body).
   *
   * This is the single most common way a Java→Node webhook port breaks, and it
   * fails closed (all webhooks rejected) rather than open, so it is at least
   * loud when it happens.
   */
  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  app.use(express.urlencoded({ extended: false }));

  // ── Health ────────────────────────────────────────────────────────────────
  // Matches Spring Actuator's path so existing probes keep working.
  const health = (_req: express.Request, res: express.Response): void => {
    res.json({ status: 'UP' });
  };
  app.get('/actuator/health', health);
  app.get('/health', health);

  // ── Authentication ────────────────────────────────────────────────────────
  // Populates req.user when a valid access token is present. Non-rejecting;
  // per-route guards do the enforcing.
  app.use(authenticate);

  /**
   * Global rule from SecurityConfig: every DELETE under /api/v1 is ADMIN-only,
   * including routes whose handler carries no role annotation. Applied here as
   * one guard rather than repeated per route, because that is how it was
   * expressed in Java and duplicating it per route is how it gets missed.
   */
  app.use('/api/v1', requireAdminForDelete);

  // ── Public routes ─────────────────────────────────────────────────────────
  // /auth/** is permitAll in SecurityConfig (login and refresh must be
  // reachable without a token). /auth/me applies requireAuth itself.
  app.use('/api/v1/auth', authRouter);

  // ── Authenticated routes ──────────────────────────────────────────────────
  app.use('/api/v1/products', requireAuth, productsRouter);
  app.use('/api/v1/listings', requireAuth, listingsRouter);
  app.use('/api/v1/orders', requireAuth, ordersRouter);
  app.use('/api/v1/pricing-profiles', requireAuth, pricingProfilesRouter);
  app.use('/api/v1/sync', requireAuth, syncRouter);
  app.use('/api/v1/marketplace/accounts', requireAuth, marketplaceAccountsRouter);
  app.use('/api/v1/audit', requireAuth, auditRouter);

  // ── Admin-only routes ─────────────────────────────────────────────────────
  // The routers apply requireRole('ADMIN') themselves; requireAuth here ensures
  // an anonymous caller gets 401 rather than 403, which is what the frontend's
  // refresh interceptor keys off.
  app.use('/api/v1/admin/users', requireAuth, adminUsersRouter);
  app.use('/api/v1/admin/dashboard', requireAuth, dashboardRouter);

  /**
   * ── Webhooks — NO authentication ───────────────────────────────────────────
   *
   * Mounted after the auth middleware but with no requireAuth guard, matching
   * `.requestMatchers("/webhooks/**").permitAll()` in SecurityConfig. Shopify
   * cannot present a JWT; authenticity comes from the HMAC over the raw body.
   *
   * Mounted LAST among routes so nothing under /api/v1 can shadow it.
   */
  app.use('/webhooks', webhooksRouter);

  /**
   * ── Shopify OAuth — NO authentication ──────────────────────────────────────
   *
   * Browser redirects during the install handshake, so no JWT exists. Mounted
   * BEFORE the authenticated /api/v1/marketplace/accounts router would match,
   * and matching `permitAll` on this path in SecurityConfig.
   *
   * Security comes from the callback HMAC plus a single-use 10-minute nonce.
   */
  app.use('/api/v1/marketplace/shopify/oauth', shopifyOAuthRouter);

  /**
   * ── eBay OAuth and notifications — NO authentication ───────────────────────
   *
   * OAuth is a browser redirect; notifications are POSTed by eBay with no
   * session. Both are permitAll in SecurityConfig.
   *
   * The notifications endpoint is what keeps the developer keyset enabled —
   * if its challenge response is wrong, eBay disables API access entirely.
   */
  app.use('/api/v1/marketplace/ebay/oauth', ebayOAuthRouter);
  app.use('/api/v1/marketplace/ebay/notifications', ebayNotificationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
