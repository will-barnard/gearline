import { sql, type RawBuilder } from 'kysely';

/**
 * SQL predicate: this FAILED / DEAD_LETTERED sync job has since been resolved.
 *
 * A job is resolved when a LATER job of the same type, for the same account,
 * product and listing, COMPLETED. A replay is the common case (Replay enqueues a
 * fresh copy and leaves the original row FAILED for history), but any later
 * successful run — a newer inventory update, a re-publish — counts, because it
 * means the thing the failed job was trying to do has been done.
 *
 * The failed row itself is kept as history; this only stops it from being
 * counted as a live problem. Nullable columns are compared with IS NOT DISTINCT
 * FROM so jobs with no product/listing (e.g. ORDER_IMPORT) still match.
 *
 * `alias` is the name the outer query uses for sync_jobs.
 */
export function isResolvedFailure(alias: string): RawBuilder<boolean> {
  const col = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<boolean>`(
    ${col('status')} IN ('FAILED', 'DEAD_LETTERED')
    AND EXISTS (
      SELECT 1 FROM sync_jobs later
      WHERE later.status = 'COMPLETED'
        AND later.job_type = ${col('job_type')}
        AND later.created_at > ${col('created_at')}
        AND later.marketplace_account_id IS NOT DISTINCT FROM ${col('marketplace_account_id')}
        AND later.product_id IS NOT DISTINCT FROM ${col('product_id')}
        AND later.listing_id IS NOT DISTINCT FROM ${col('listing_id')}
    )
  )`;
}
