/**
 * Helpers for listings whose work happens in a background worker.
 *
 * POST /listings/:id/publish and /delist return 202 — the job is queued, not
 * done. Reloading straight afterwards shows the row exactly as it was, which
 * reads as "the button did nothing", and the real outcome only appears on a
 * later manual refresh.
 */

/** Statuses that mean the worker has not finished with this listing yet. */
export const TRANSIENT_LISTING_STATUSES = ['PENDING', 'PUBLISHING']

export function isTransientStatus(status) {
  return TRANSIENT_LISTING_STATUSES.includes(status)
}

/**
 * Refreshes until the listing settles, or the budget runs out.
 *
 * The budget matters: a stuck or dead-lettered job must not spin the browser
 * forever. When it expires the row is left showing its transient status, which
 * is the truth — the job really has not finished.
 *
 * Returns true if it settled, false if the budget expired.
 */
export async function pollUntilSettled(refresh, stillTransient, options = {}) {
  const { attempts = 20, intervalMs = 1500 } = options

  for (let i = 0; i < attempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    await refresh()
    if (!stillTransient()) return true
  }

  return false
}
