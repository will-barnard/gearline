/**
 * Groups marketplace listings by the product they belong to.
 *
 * The listing APIs return one row per (product × marketplace), which is the
 * right shape for the database and the wrong shape for a person: the same
 * instrument appears two or three times in a table, once per channel, and the
 * eye reads that as duplicate stock rather than one item listed in several
 * places.
 *
 * Products are per-variant since V18, so a group is exactly one sellable thing.
 * Two variants of one cable stay two groups, which is correct — they have
 * different SKUs, prices and stock.
 *
 * Grouping happens client-side: both views already fetch every listing they
 * display, and the product fields ride along on each row.
 */

/** Queued or mid-flight — the worker still has it. */
export const WORKING_STATUSES = ['PENDING', 'PUBLISHING']

/** Waiting for a human to publish. This is the "ready" count. */
export const READY_STATUSES = ['NEEDS_REVIEW']

/** Been somewhere and come back; can be published again. */
export const REPUBLISHABLE_STATUSES = ['FAILED', 'INACTIVE', 'DELISTED']

const MARKETPLACE_ORDER = ['REVERB', 'EBAY', 'SHOPIFY']

/**
 * Stable channel ordering, so a product's chips don't reshuffle between
 * refreshes as rows come back in a different order.
 */
function byMarketplace(a, b) {
  const ai = MARKETPLACE_ORDER.indexOf(a.marketplaceType)
  const bi = MARKETPLACE_ORDER.indexOf(b.marketplaceType)
  if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  return (a.marketplaceType || '').localeCompare(b.marketplaceType || '')
}

export function groupByProduct(listings) {
  const groups = new Map()

  for (const listing of listings || []) {
    const key = listing.productId ?? `orphan:${listing.id}`
    let group = groups.get(key)

    if (!group) {
      group = {
        productId: listing.productId,
        productTitle: listing.productTitle,
        productSku: listing.productSku,
        productPrice: listing.productPrice,
        productQuantity: listing.productQuantity,
        listings: [],
      }
      groups.set(key, group)
    }

    group.listings.push(listing)
  }

  return [...groups.values()].map((group) => {
    const listings = [...group.listings].sort(byMarketplace)
    const count = (statuses) => listings.filter((l) => statuses.includes(l.listingStatus)).length

    return {
      ...group,
      listings,
      readyCount: count(READY_STATUSES),
      workingCount: count(WORKING_STATUSES),
      activeCount: count(['ACTIVE']),
      failedCount: count(['FAILED']),
      republishableCount: count(REPUBLISHABLE_STATUSES),
      /** Listing ids a single "publish all" action would act on. */
      readyListingIds: listings
        .filter((l) => READY_STATUSES.includes(l.listingStatus))
        .map((l) => l.id),
    }
  })
}

/**
 * One line describing where a product stands across every channel, for the
 * collapsed row. Ordered by what needs a decision first.
 */
export function summarise(group) {
  const parts = []
  if (group.readyCount) parts.push(`${group.readyCount} ready to publish`)
  if (group.workingCount) parts.push(`${group.workingCount} working`)
  if (group.activeCount) parts.push(`${group.activeCount} live`)
  if (group.failedCount) parts.push(`${group.failedCount} failed`)
  return parts.join(' · ')
}
