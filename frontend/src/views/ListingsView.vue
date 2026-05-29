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
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Marketplace</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">External ID</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
              <th class="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Price</th>
              <th class="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Qty</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Last Sync</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Error</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in listings" :key="l.id" class="table-row">
              <td class="px-4 py-3">
                <span class="badge-blue">{{ l.marketplaceType }}</span>
              </td>
              <td class="px-4 py-3 font-mono text-xs text-gray-400">{{ l.externalListingId || '—' }}</td>
              <td class="px-4 py-3">
                <span :class="listingBadge(l.listingStatus)">{{ l.listingStatus }}</span>
              </td>
              <td class="px-4 py-3 text-right text-gray-200">{{ l.syncedPrice ? `$${l.syncedPrice}` : '—' }}</td>
              <td class="px-4 py-3 text-right text-gray-200">{{ l.syncedQuantity ?? '—' }}</td>
              <td class="px-4 py-3 text-xs text-gray-500">{{ formatDate(l.lastSyncAt) }}</td>
              <td class="px-4 py-3 max-w-xs">
                <span v-if="l.lastError" class="text-xs text-red-400 truncate block" :title="l.lastError">{{ l.lastError }}</span>
              </td>
              <td class="px-4 py-3">
                <div class="flex gap-2 justify-end">
                  <!-- NEEDS_REVIEW gets a prominent amber Publish button -->
                  <button
                    v-if="l.listingStatus === 'NEEDS_REVIEW'"
                    @click="publishListing(l.id)"
                    class="rounded px-3 py-1 text-xs font-medium bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors"
                  >Publish</button>
                  <!-- Other non-active statuses get a quieter link -->
                  <button
                    v-else-if="l.listingStatus !== 'ACTIVE'"
                    @click="publishListing(l.id)"
                    class="text-xs text-brand-400 hover:text-brand-300 transition-colors"
                  >Publish</button>
                  <button
                    v-if="l.listingStatus === 'ACTIVE'"
                    @click="delistListing(l.id)"
                    class="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >Delist</button>
                </div>
              </td>
            </tr>
            <tr v-if="listings.length === 0">
              <td colspan="8" class="px-4 py-12 text-center text-sm text-gray-500">No listings found</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import api from '@/lib/api'

const listings = ref([])
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

async function publishListing(id) {
  await api.post(`/listings/${id}/publish`)
  load()
}

async function delistListing(id) {
  await api.post(`/listings/${id}/delist`)
  load()
}

function listingBadge(s) {
  const map = {
    ACTIVE:       'badge-green',
    FAILED:       'badge-red',
    PENDING:      'badge-yellow',
    NEEDS_REVIEW: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-500/20 text-amber-300',
    PUBLISHING:   'badge-blue',
    SOLD:         'badge-blue',
    DELISTED:     'badge-gray',
    INACTIVE:     'badge-gray',
  }
  return map[s] || 'badge-gray'
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString()
}

watch(statusFilter, load)
onMounted(load)
</script>
