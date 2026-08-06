import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import { sql } from 'kysely';

import { db } from './index.js';
import { loggerFor } from '../logger.js';

const log = loggerFor('migrate');

/**
 * Minimal Flyway-compatible migration runner.
 *
 * ── Why not just use the Flyway image ────────────────────────────────────────
 *
 * `flyway/flyway` bundles JDBC drivers for every database it supports —
 * Databricks, Snowflake, Oracle, DB2, SQL Server, and more. That is roughly a
 * gigabyte of image to execute 17 plain Postgres files, and on a 20 GB VM it
 * was enough to fill the disk mid-pull.
 *
 * This runner does the same job in a few hundred lines, inside the container
 * that already exists.
 *
 * ── Staying Flyway-compatible ────────────────────────────────────────────────
 *
 * It reads and writes the SAME `flyway_schema_history` table, in the same
 * format, with the SAME CRC32 checksum algorithm. So:
 *
 *   - Your existing history (V1–V17, applied by Java) is recognised, and those
 *     migrations are NOT re-run.
 *   - If you ever want real Flyway back, point it at this database and it will
 *     validate cleanly.
 *
 * The checksum is the fiddly part and is reproduced deliberately — Flyway CRCs
 * each line WITHOUT its terminator, so a file that differs only in CRLF vs LF
 * hashes identically. Getting it wrong would make Flyway report a checksum
 * mismatch on every file and refuse to run.
 */

const MIGRATIONS_DIR = process.env['MIGRATIONS_DIR'] ?? './migrations';

/**
 * Advisory lock ID. Arbitrary but must be stable.
 *
 * Beachhead's blue/green swap can briefly run two containers at once, and both
 * would try to migrate. The lock makes the second wait, then find nothing to do.
 */
const ADVISORY_LOCK_ID = 4_827_195_003;

interface Migration {
  version: string;
  description: string;
  script: string;
  sql: string;
  checksum: number;
}

/**
 * Flyway's checksum: a CRC32 accumulated over each line's UTF-8 bytes, with
 * line terminators stripped.
 *
 * Stripping the terminators is what makes it line-ending agnostic — a file
 * checked out with CRLF on Windows produces the same value as LF on Linux.
 */
function flywayChecksum(content: string): number {
  let crc = 0;

  // split(/\r\n|\r|\n/) matches BufferedReader.readLine() semantics.
  const lines = content.split(/\r\n|\r|\n/);

  // A trailing newline yields a final empty element that readLine() would never
  // return. Drop it, or the checksum differs from Flyway's by that empty line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  for (const line of lines) {
    crc = crc32(Buffer.from(line, 'utf8'), crc);
  }

  // Flyway stores the checksum as a SIGNED 32-bit int; Node returns unsigned.
  return crc | 0;
}

/** Parses `V17__add_marketplace_excluded_to_products.sql`. */
function parseFilename(filename: string): { version: string; description: string } | null {
  const match = /^V(\d+(?:[._]\d+)*)__(.+)\.sql$/.exec(filename);
  if (!match) return null;

  const [, version = '', rawDescription = ''] = match;

  return {
    version: version.replace(/_/g, '.'),
    // Flyway turns underscores into spaces for the description column.
    description: rawDescription.replace(/_/g, ' '),
  };
}

/**
 * Numeric version comparison.
 *
 * Lexical sorting would order V10 before V2 and apply migrations out of order,
 * which for this schema means V10 altering a column V3 has not created yet.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function loadMigrations(): Promise<Migration[]> {
  let filenames: string[];

  try {
    filenames = await readdir(MIGRATIONS_DIR);
  } catch (err) {
    throw new Error(
      `Could not read the migrations directory "${MIGRATIONS_DIR}": ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const migrations: Migration[] = [];

  for (const filename of filenames) {
    if (!filename.endsWith('.sql')) continue;

    const parsed = parseFilename(filename);
    if (!parsed) {
      log.warn({ filename }, 'Skipping file that does not match V{version}__{description}.sql');
      continue;
    }

    const content = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');

    migrations.push({
      version: parsed.version,
      description: parsed.description,
      script: filename,
      sql: content,
      checksum: flywayChecksum(content),
    });
  }

  migrations.sort((a, b) => compareVersions(a.version, b.version));

  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version V${m.version} — refusing to run`);
    }
    seen.add(m.version);
  }

  return migrations;
}

/** Creates the history table if absent, matching Flyway's own DDL. */
async function ensureHistoryTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS flyway_schema_history (
      installed_rank INTEGER NOT NULL,
      version        VARCHAR(50),
      description    VARCHAR(200) NOT NULL,
      type           VARCHAR(20)  NOT NULL,
      script         VARCHAR(1000) NOT NULL,
      checksum       INTEGER,
      installed_by   VARCHAR(100) NOT NULL,
      installed_on   TIMESTAMP    NOT NULL DEFAULT now(),
      execution_time INTEGER      NOT NULL,
      success        BOOLEAN      NOT NULL,
      CONSTRAINT flyway_schema_history_pk PRIMARY KEY (installed_rank)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS flyway_schema_history_s_idx
      ON flyway_schema_history (success)
  `.execute(db);
}

interface AppliedRow {
  version: string | null;
  checksum: number | null;
  script: string;
  success: boolean;
  installed_rank: number;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

/**
 * Applies any pending migrations.
 *
 * Each migration runs in its OWN transaction together with its history row, so
 * a failure halfway through leaves earlier migrations committed and this one
 * fully rolled back — never half-applied.
 *
 * Failures are fatal: the process should not start against a schema it does not
 * understand.
 */
export async function runMigrations(): Promise<MigrationResult> {
  const migrations = await loadMigrations();

  if (migrations.length === 0) {
    log.warn({ dir: MIGRATIONS_DIR }, 'No migration files found');
    return { applied: [], alreadyApplied: 0 };
  }

  // Serialise against other booting containers.
  await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_ID})`.execute(db);

  try {
    await ensureHistoryTable();

    const { rows: applied } = await sql<AppliedRow>`
      SELECT version, checksum, script, success, installed_rank
      FROM flyway_schema_history
      WHERE version IS NOT NULL
      ORDER BY installed_rank
    `.execute(db);

    /**
     * A failed row means a previous run died mid-migration. Flyway refuses to
     * continue until it is repaired, and so do we — the schema is in an unknown
     * state and guessing makes it worse.
     */
    const failed = applied.find((r) => !r.success);
    if (failed) {
      throw new Error(
        `flyway_schema_history contains a FAILED entry: V${failed.version} (${failed.script}). ` +
          'Repair the schema manually and delete that row before deploying again.',
      );
    }

    const appliedByVersion = new Map(applied.map((r) => [r.version ?? '', r]));

    /**
     * Checksum validation on already-applied migrations.
     *
     * ── Warning, not fatal, by default ─────────────────────────────────────
     *
     * A mismatch usually means an already-applied migration was edited. That is
     * worth knowing about, but it is NOT dangerous on its own: the migration
     * already ran, and this runner skips it by version regardless of checksum.
     * Nothing is re-executed.
     *
     * It is a warning rather than an error because these rows were written by
     * Java's Flyway, and this is a reimplementation of its CRC32. If the two
     * disagree by some subtlety, a hard failure would block every deploy over a
     * cosmetic difference — a much worse outcome than a log line.
     *
     * Set MIGRATE_STRICT_CHECKSUM=true to make it fatal once you have confirmed
     * the checksums line up (see DEPLOY.md for the query).
     */
    const strict = process.env['MIGRATE_STRICT_CHECKSUM'] === 'true';
    let mismatches = 0;

    for (const migration of migrations) {
      const row = appliedByVersion.get(migration.version);
      if (!row || row.checksum === null) continue;

      if (row.checksum !== migration.checksum) {
        mismatches++;
        const detail = {
          version: migration.version,
          script: migration.script,
          appliedChecksum: row.checksum,
          fileChecksum: migration.checksum,
        };

        if (strict) {
          throw new Error(
            `Checksum mismatch for V${migration.version} (${migration.script}). ` +
              `Applied: ${row.checksum}, file now: ${migration.checksum}. ` +
              'MIGRATE_STRICT_CHECKSUM is enabled.',
          );
        }

        log.warn(
          detail,
          'Checksum differs from the recorded value. The migration already ran and will ' +
            'NOT be re-applied. Either the file was edited, or this runner computes CRC32 ' +
            'slightly differently from the Flyway build that wrote the row.',
        );
      }
    }

    if (mismatches > 0) {
      log.warn(
        { mismatches, total: applied.length },
        'Some recorded checksums do not match. Harmless for applied migrations, but ' +
          'worth confirming before enabling MIGRATE_STRICT_CHECKSUM.',
      );
    }

    const pending = migrations.filter((m) => !appliedByVersion.has(m.version));

    if (pending.length === 0) {
      log.info(
        { alreadyApplied: applied.length, latest: migrations[migrations.length - 1]?.version },
        'Schema is up to date',
      );
      return { applied: [], alreadyApplied: applied.length };
    }

    log.info({ count: pending.length }, 'Applying pending migrations');

    let rank = applied.reduce((max, r) => Math.max(max, r.installed_rank), 0);
    const appliedNow: string[] = [];

    for (const migration of pending) {
      rank++;
      const started = Date.now();

      await db.transaction().execute(async (trx) => {
        // The file may contain multiple statements; sql.raw sends it as one
        // block, which Postgres executes as an implicit multi-statement.
        await sql.raw(migration.sql).execute(trx);

        await sql`
          INSERT INTO flyway_schema_history
            (installed_rank, version, description, type, script,
             checksum, installed_by, installed_on, execution_time, success)
          VALUES
            (${rank}, ${migration.version}, ${migration.description}, 'SQL', ${migration.script},
             ${migration.checksum}, ${'gearline-node'}, now(), ${Date.now() - started}, true)
        `.execute(trx);
      });

      log.info(
        { version: migration.version, script: migration.script, ms: Date.now() - started },
        'Applied migration',
      );
      appliedNow.push(migration.version);
    }

    return { applied: appliedNow, alreadyApplied: applied.length };
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_ID})`.execute(db);
  }
}

/** Exposed for tests. */
export const __internals = { flywayChecksum, parseFilename, compareVersions };
