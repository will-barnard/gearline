<template>
  <div class="flex flex-col h-full">
    <header class="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-800 px-6">
      <div class="flex items-center gap-4">
        <h1 class="text-lg font-semibold text-white">Listings</h1>
        <span
          v-if="needsReviewCount > 0"
          class="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-400"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse"></span>
          {{ needsReviewCount }} pending review
        </span>
      </div>
      <select v-model="statusFilter" class="input w-44 py-1.5 text-xs">
        <option value="">All statuses</option>
        <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
      </select>
    </header>

    <div class="flex-1 overflow-auto p-6">
      <div v-if="loading" class="flex justify-center py-16">
        <div class="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"></div>
      </div>

      <div v-else class="overflow-hidden rounded-xl border border-gray-800">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 bg-gray-900">
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Product</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Channels</th>
              <th class="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Price</th>
              <th class="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Qty</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Error</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            <ProductListingGroup
              v-for="g in groups"
              :key="g.productId"
              :group="g"
              @publish="publishListings"
              @delist="delistListing"
              @archive="dismissListing"
            />
            <tr v-if="groups.length === 0">
              <td colspan="6" class="px-4 py-10 text-center text-xs text-gray-500">
                No listings match this filter.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, onMounted } from 'vue'
import api from '@/lib/api'
import { isTransientStatus, pollUntilSettled } from '@/lib/listingStatus'
import { groupByProduct } from '@/lib/groupListings'
import ProductListingGroup from '@/components/listings/ProductListingGroup.vue'

const listings = ref([])
/**
 * One row per product rather than per (product x marketplace). The API returns
 * the flat shape; showing it verbatim made one instrument look like two or
 * three items of stock.
 */
const groups = computed(() => groupByProduct(listings.value))
const loading = ref(true)
const statusFilter = ref('')
const statuses = ['PENDING','PUBLISHING','ACTIVE','INACTIVE','SOLD','DELISTED','FAILED','NEEDS_REVIEW']
const needsReviewCount = ref(0)

async function load() {
  loading.value = true
  try {
    const res = await api.get('/listings', { params: { page: 0, size: 100, status: statusFilter.value || undefined } })
    listings.value = res.data.content
    // Keep the header badge accurate when showing all statuses
    if (!statusFilter.value) {
      needsReviewCount.value = res.data.content.filter(l => l.listingStatus === 'NEEDS_REVIEW').length
    }
  } finally { loading.value = false }
}

/** True while any of these listings is still queued or mid-publish. */
function stillWorking(ids) {
  return listings.value.some((l) => ids.includes(l.id) && isTransientStatus(l.listingStatus))
}

/**
 * Publish and delist return 202 — the worker picks the job up afterwards. Poll
 * until every listing acted on settles, so the outcome (ACTIVE, or FAILED with
 * a reason) appears on its own instead of on the next manual refresh.
 *
 * Takes a LIST because the collapsed row publishes a product to every channel
 * that is ready in one click.
 */
async function runListingJobs(ids, action) {
  await Promise.all(ids.map((id) => api.post(`/listings/${id}/${action}`)))
  await load()
  await pollUntilSettled(load, () => stillWorking(ids))
}

async function publishListings(ids) {
  await runListingJobs(ids, 'publish')
}

async function delistListing(id) {
  await runListingJobs([id], 'delist')
}

async function dismissListing(id) {
  await api.delete(`/listings/${id}`)
  load()
}

watch(statusFilter, load)
onMounted(load)
</script>
