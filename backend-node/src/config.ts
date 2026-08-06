/**
 * Application configuration.
 *
 * Variable names match the ones the Java service used, so the existing
 * Beachhead environment carries over unchanged.
 *
 * DATABASE_URL is the preferred form. The SPRING_DATASOURCE_* fallback is kept
 * because it costs almost nothing and means a rollback to the Java service — or
 * running both side by side again — needs no dashboard changes. Remove
 * parseJdbcUrl and the fallback once you are confident the Java service is
 * never coming back.
 */

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === null ? fallback : v;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Converts a Spring JDBC URL into the pieces `pg` needs.
 *
 * `jdbc:postgresql://postgres:5432/gearline` → host=postgres port=5432 db=gearline
 *
 * Query parameters on the JDBC URL (e.g. `?sslmode=require`) are preserved and
 * re-attached so TLS settings survive the translation.
 */
export function parseJdbcUrl(jdbcUrl: string): {
  host: string;
  port: number;
  database: string;
  search: string;
} | null {
  const match = /^jdbc:postgresql:\/\/([^/?]+)\/([^?]+)(\?.*)?$/.exec(jdbcUrl);
  if (!match) return null;

  const [, hostPort = '', database = '', search = ''] = match;
  const [host = 'localhost', portRaw] = hostPort.split(':');
  const port = portRaw ? Number.parseInt(portRaw, 10) : 5432;

  return {
    host,
    port: Number.isFinite(port) ? port : 5432,
    database,
    search,
  };
}

function buildDatabaseUrl(): string {
  const direct = env('DATABASE_URL');
  if (direct) return direct;

  const jdbc = env('SPRING_DATASOURCE_URL', 'jdbc:postgresql://localhost:5432/gearline');
  const user = env('SPRING_DATASOURCE_USERNAME', 'gearline');
  const password = env('SPRING_DATASOURCE_PASSWORD', 'gearline');

  const parsed = parseJdbcUrl(jdbc);
  if (!parsed) {
    throw new Error(
      `Could not parse SPRING_DATASOURCE_URL as a JDBC PostgreSQL URL: "${jdbc}". ` +
        'Set DATABASE_URL explicitly instead.',
    );
  }

  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@${parsed.host}:${parsed.port}/${parsed.database}${parsed.search}`;
}

export const config = {
  port: intEnv('PORT', 3001),
  nodeEnv: env('NODE_ENV', 'production'),
  logLevel: env('LOG_LEVEL', 'info'),

  database: {
    url: buildDatabaseUrl(),
    /**
     * Hikari used maximum-pool-size: 20. Node is single-threaded and does far
     * less blocking work per request, so a smaller pool is plenty and leaves
     * connection headroom for pg-boss, which opens its own pool.
     */
    maxConnections: intEnv('DB_POOL_MAX', 10),
    idleTimeoutMs: intEnv('DB_POOL_IDLE_TIMEOUT_MS', 600_000),
    connectionTimeoutMs: intEnv('DB_CONNECTION_TIMEOUT_MS', 30_000),
  },

  jwt: {
    /**
     * Read raw. The signing key is the UTF-8 bytes of this string — see
     * src/security/jwt.ts for why, and why its LENGTH selects the algorithm.
     */
    secret: env(
      'JWT_SECRET',
      'change-me-in-production-use-at-least-64-char-secret-key-here-ok',
    ),
    accessTokenExpiryMs: intEnv('JWT_ACCESS_EXPIRY_MS', 63_072_000_000), // 2 years
    refreshTokenExpiryMs: intEnv('JWT_REFRESH_EXPIRY_MS', 63_072_000_000), // 2 years
  },

  app: {
    baseUrl: env('APP_BASE_URL', 'http://localhost:8080'),
  },

  credential: {
    /** Base64-encoded 32-byte AES-256 key. Blank = pass-through (dev only). */
    encryptionKey: env('CREDENTIAL_ENCRYPTION_KEY'),
  },

  bootstrap: {
    adminEmail: env('ADMIN_EMAIL'),
    adminPassword: env('ADMIN_PASSWORD'),
  },

  shopify: {
    clientId: env('SHOPIFY_CLIENT_ID'),
    clientSecret: env('SHOPIFY_CLIENT_SECRET'),
    scopes:
      'read_products,write_products,read_inventory,write_inventory,' +
      'read_orders,write_orders,read_fulfillments,write_fulfillments',
    flowSecret: env('SHOPIFY_FLOW_SECRET'),
    flowTokenHeader: env('SHOPIFY_FLOW_TOKEN_HEADER', 'X-Shopify-Flow-Token'),
  },

  reverb: {
    clientId: env('REVERB_CLIENT_ID'),
    clientSecret: env('REVERB_CLIENT_SECRET'),
    apiBaseUrl: env('REVERB_API_BASE_URL', 'https://reverb.com/api'),
    authUrl: env('REVERB_AUTH_URL', 'https://reverb.com/oauth'),
  },

  ebay: {
    clientId: env('EBAY_CLIENT_ID'),
    clientSecret: env('EBAY_CLIENT_SECRET'),
    apiBaseUrl: env('EBAY_API_BASE_URL', 'https://api.ebay.com'),
    authUrl: env('EBAY_AUTH_URL', 'https://auth.ebay.com/oauth2'),
    ruName: env('EBAY_RU_NAME'),
    notificationVerificationToken: env('EBAY_NOTIFICATION_VERIFICATION_TOKEN'),
  },

  sync: {
    maxRetryAttempts: intEnv('SYNC_MAX_RETRY_ATTEMPTS', 5),
    initialRetryDelayMs: intEnv('SYNC_INITIAL_RETRY_DELAY_MS', 1_000),
    maxRetryDelayMs: intEnv('SYNC_MAX_RETRY_DELAY_MS', 300_000),
    retryPollIntervalMs: intEnv('SYNC_RETRY_POLL_INTERVAL_MS', 60_000),
    retryPollInitialDelayMs: intEnv('SYNC_RETRY_POLL_INITIAL_DELAY_MS', 30_000),
  },

  queue: {
    /** pg-boss queue name. Replaces the RabbitMQ exchange/routing-key scheme. */
    syncQueue: env('QUEUE_SYNC_NAME', 'gearline.sync.jobs'),
    /** How many sync jobs may run concurrently in this process. */
    concurrency: intEnv('QUEUE_CONCURRENCY', 5),
    /** Postgres schema pg-boss creates its own tables in. */
    schema: env('QUEUE_SCHEMA', 'pgboss'),
  },

  orderPolling: {
    intervalMs: intEnv('ORDER_POLL_INTERVAL_MS', 600_000), // 10 minutes
    initialDelayMs: intEnv('ORDER_POLL_INITIAL_DELAY_MS', 60_000), // 1 minute
  },
} as const;

export type Config = typeof config;
