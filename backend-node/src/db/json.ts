import { sql, type RawBuilder } from 'kysely';

/**
 * JSONB write helpers.
 *
 * ── Why these all return RawBuilder<string> ──────────────────────────────────
 *
 * The JSONB columns in db/types.ts declare their INSERT/UPDATE type as
 * `string | RawBuilder<string>`. These helpers emit `'...'::jsonb`, so
 * `RawBuilder<string>` is what satisfies that.
 *
 * The generic parameter describes the shape being written, purely for the
 * reader — it is not carried into the return type, because Kysely matches the
 * expression against the column's declared write type, not against the parsed
 * shape it reads back.
 *
 * Every JSONB write must go through one of these. Passing a plain object lets
 * node-pg coerce it to "[object Object]", which is accepted by Postgres as a
 * string and corrupts the row.
 */

/** Serialises a value for insertion into a JSONB column. */
export function toJson<T>(value: T): RawBuilder<string> {
  return sql<string>`${JSON.stringify(value)}::jsonb`;
}

/**
 * Merges keys into an existing JSONB object server-side using `||`.
 *
 * Used by the listing_overrides and sync_settings PATCH endpoints, which have
 * merge rather than replace semantics. Doing the merge in SQL instead of
 * read-modify-write in JS closes a lost-update race: two concurrent PATCHes
 * setting different keys would otherwise clobber each other.
 *
 * Note `||` cannot REMOVE a key — see jsonRemoveKey.
 */
export function jsonMerge(column: string, patch: Record<string, unknown>): RawBuilder<string> {
  return sql<string>`COALESCE(${sql.ref(column)}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

/** Removes a top-level key from a JSONB object server-side. */
export function jsonRemoveKey(column: string, key: string): RawBuilder<string> {
  return sql<string>`COALESCE(${sql.ref(column)}, '{}'::jsonb) - ${key}`;
}
