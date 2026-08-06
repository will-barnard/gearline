import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { config } from '../config.js';
import { loggerFor } from '../logger.js';
import type { Database } from './types.js';

const log = loggerFor('db');

/**
 * Force NUMERIC (OID 1700) to come back as a string rather than a JS number.
 *
 * This is not a style preference — it is a correctness requirement. Prices are
 * NUMERIC(10,2) and JS numbers are IEEE-754 doubles. Letting node-pg parse them
 * into floats would reintroduce exactly the rounding errors that BigDecimal was
 * chosen to avoid on the Java side, and those errors would be published to live
 * marketplace listings. All money in this codebase moves as strings and is only
 * converted inside the decimal helpers.
 */
pg.types.setTypeParser(1700, (value: string) => value);

/**
 * INT8 / BIGINT (OID 20) also comes back as a string by default in node-pg.
 * We keep that behaviour for the `version` columns (which are BIGINT) but the
 * dashboard COUNT(*) queries also return INT8, so those are parsed explicitly
 * at the call site rather than globally.
 */

export const pool = new pg.Pool({
  connectionString: config.database.url,
  max: config.database.maxConnections,
  idleTimeoutMillis: config.database.idleTimeoutMs,
  connectionTimeoutMillis: config.database.connectionTimeoutMs,
  application_name: 'gearline-node',
});

pool.on('error', (err) => {
  // An idle client erroring is usually the database restarting underneath us.
  // pg will replace the client; log it but do not crash the process.
  log.error({ err }, 'Idle Postgres client error');
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

/**
 * Verifies connectivity and that Flyway has run to at least the version this
 * code expects.
 *
 * The Node service deliberately does NOT run migrations — Flyway in the Java
 * service owns the schema. But starting up against a database that predates
 * V17 would produce confusing "column does not exist" errors deep in a request,
 * so we fail fast at boot with a clear message instead.
 */
export async function verifyDatabase(minSchemaVersion = 17): Promise<void> {
  await sql`SELECT 1`.execute(db);

  const result = await sql<{ version: string | null }>`
    SELECT MAX(version::numeric)::text AS version
    FROM flyway_schema_history
    WHERE success = true
  `
    .execute(db)
    .catch(() => null);

  const applied = result?.rows[0]?.version;

  if (applied === undefined || applied === null) {
    log.warn(
      'Could not read flyway_schema_history — skipping schema version check. ' +
        'This is expected only if the Java service has never run against this database.',
    );
    return;
  }

  const appliedVersion = Number.parseFloat(applied);
  if (appliedVersion < minSchemaVersion) {
    throw new Error(
      `Database schema is at Flyway version ${applied} but this build requires ` +
        `at least V${minSchemaVersion}. Deploy the Java service first so Flyway ` +
        'can migrate, then start the Node service.',
    );
  }

  log.info({ schemaVersion: applied }, 'Database connection verified');
}

export async function closeDatabase(): Promise<void> {
  await db.destroy();
}

export { sql };
