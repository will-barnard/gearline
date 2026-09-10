<template>
  <div class="flex flex-col h-full overflow-auto">
    <!-- Header -->
    <header class="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-800 px-6">
      <h1 class="text-lg font-semibold text-white">Dashboard</h1>
      <span class="text-xs text-gray-500">Last refreshed: {{ refreshedAt }}</span>
    </header>

    <div class="flex-1 overflow-auto p-6 space-y-6">

      <!-- ── Pending Review queue — shown prominently when non-empty ─────── -->
      <div v-if="stats.pendingReviewListings > 0 || reviewLoading" class="rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
        <div class="mb-4 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <!-- amber dot -->
            <span class="inline-flex h-2.5 w-2.5 rounded-full bg-amber-400 animate-pulse"></span>
            <h2 class="text-sm font-semibold text-amber-300">
              Ready to Publish
              <span class="ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400">
                {{ stats.pendingReviewListings }}
              </span>
            </h2>
          </div>
          <p class="text-xs text-gray-500">
            One row per product. Expand a row to see each marketplace, or publish to all of
            its ready channels at once.
          </p>
        </div>

        <div v-if="reviewLoading" class="flex justify-center py-6">
          <div class="h-6 w-6 animate-spin rounded-full border-2 border-amber-400 border-t-transparent"></div>
        </div>

        <div v-else-if="reviewGroups.length > 0" class="overflow-hidden rounded-lg border border-gray-800">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-800 bg-gray-900">
                <th class="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Product</th>
                <th class="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Channels</th>
                <th class="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Price</th>
                <th class="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Qty</th>
                <th class="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Error</th>
                <th class="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              <ProductListingGroup
                v-for="g in reviewGroups"
                :key="g.productId"
                :group="g"
                @publish="publishListings"
                @archive="dismissListing"
              />
            </tbody>
          </table>
        </div>

        <!-- Truncation notice — shown when we have more listings than we loaded -->
        <div v-else-if="reviewListings.length > 0 && reviewTotal > reviewListings.length"
             class="mt-3 rounded-lg border border-amber-700/40 bg-amber-900/20 px-4 py-3 text-xs text-amber-300">
          Showing {{ reviewListings.length }} of {{ reviewTotal }} listings,
          across {{ reviewGroups.length }} product{{ reviewGroups.length !== 1 ? 's' : '' }}.
          <span class="text-amber-400 font-medium">{{ reviewTotal - reviewListings.length }} more not shown.</span>
          If many of these are deposit listings or restoration placeholders, go to
          <router-link to="/products" class="underline hover:text-white">Products → Excluded</router-link>
          to bulk-exclude them and clear the queue.
        </div>

        <div v-else class="py-4 text-center text-xs text-gray-500">
          No pending listings found — counts may be stale, try refreshing.
        </div>
      </div>

      <!-- ── Stats grid ──────────────────────────────────────────────────── -->
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Active Listings"   :value="stats.activeListings"        color="green"  :loading="loading" />
        <StatCard label="Pending Review"    :value="stats.pendingReviewListings"  color="amber"  :loading="loading" />
        <StatCard label="Failed Listings"   :value="stats.failedListings"         color="red"    :loading="loading" />
        <StatCard label="Total Orders"      :value="stats.totalOrders"            color="blue"   :loading="loading" />
      </div>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <StatCard label="Total Products"    :value="stats.totalProducts"          color="gray"   :loading="loading" />
        <StatCard label="In-Progress Jobs"  :value="stats.inProgressSyncJobs"     color="blue"   :loading="loading" />
        <StatCard label="Connected Accounts":value="stats.connectedAccounts"      color="green"  :loading="loading" />
      </div>

      <!-- ── Health indicators ───────────────────────────────────────────── -->
      <div class="card">
        <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500">Operational Health</h2>
        <div class="space-y-3">
          <HealthRow
            label="Pending Review"
            :healthy="stats.pendingReviewListings === 0"
            :detail="stats.pendingReviewListings > 0
              ? `${stats.pendingReviewListings} listing${stats.pendingReviewListings !== 1 ? 's' : ''} waiting for manual publish`
              : 'No listings awaiting review'"
          />
          <HealthRow
            label="Active Listings"
            :healthy="stats.failedListings === 0"
            :detail="stats.failedListings > 0 ? `${stats.failedListings} listings need attention` : 'All listings synced'"
          />
          <HealthRow
            label="Sync Queue"
            :healthy="stats.failedSyncJobs === 0"
            :detail="stats.failedSyncJobs > 0 ? `${stats.failedSyncJobs} jobs failed` : 'Queue healthy'"
          />
          <HealthRow
            label="Marketplace Connections"
            :healthy="stats.connectedAccounts > 0"
            :detail="`${stats.connectedAccounts} account${stats.connectedAccounts !== 1 ? 's' : ''} connected`"
          />
        </div>
      </div>

      <!-- ── Quick actions ───────────────────────────────────────────────── -->
      <div class="card">
        <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500">Quick Actions</h2>
        <div class="flex flex-wrap gap-3">
          <router-link to="/listings" class="btn-secondary">View All Listings</router-link>
          <router-link to="/sync" class="btn-secondary">View Sync Activity</router-link>
          <router-link to="/marketplaces" class="btn-secondary">Manage Connections</router-link>
          <router-link to="/audit" class="btn-secondary">Audit Logs</router-link>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import api from '@/lib/api'
import StatCard from '@/components/dashboard/StatCard.vue'
import HealthRow from '@/components/dashboard/HealthRow.vue'
import ProductListingGroup from '@/components/listings/ProductListingGroup.vue'
import { groupByProduct } from '@/lib/groupListings'

const stats = ref({
  totalProducts: 0, activeListings: 0, failedListings: 0, pendingReviewListings: 0,
  totalOrders: 0, failedSyncJobs: 0, inProgressSyncJobs: 0, connectedAccounts: 0
})
const loading = ref(true)
const refreshedAt = ref('—')

// Review queue state
const reviewListings = ref([])
/**
 * The queue is per (product x marketplace); a product awaiting review on both
 * Reverb and eBay appeared as two rows that looked like two items. Grouping
 * makes one row with a count, which is what the operator is deciding about.
 */
const reviewGroups = computed(() => groupByProduct(reviewListings.value))
const reviewLoading = ref(false)
const reviewTotal = ref(0)   // total NEEDS_REVIEW count from stats
const publishing = ref({})

async function loadStats() {
  loading.value = true
  try {
    const res = await api.get('/admin/dashboard/stats')
    stats.value = res.data
    refreshedAt.value = new Date().toLocaleTimeString()
      // Load the review queue whenever stats say there's something pending
    if (res.data.pendingReviewListings > 0) {
      reviewTotal.value = res.data.pendingReviewListings
      loadReviewQueue()
    }
  } catch (e) {
    console.error('Failed to load dashboard stats', e)
  } finally {
    loading.value = false
  }
}

async function loadReviewQueue() {
  reviewLoading.value = true
  try {
    const res = await api.get('/listings', { params: { status: 'NEEDS_REVIEW', page: 0, size: 200 } })
    reviewListings.value = res.data.content
  } catch (e) {
    console.error('Failed to load review queue', e)
  } finally {
    reviewLoading.value = false
  }
}

/**
 * Publishes every ready channel for one product in a single click.
 *
 * Each id still becomes its own job — the API is per listing — but the operator
 * makes one decision per product rather than one per channel.
 */
async function publishListings(ids) {
  for (const id of ids) publishing.value[id] = true
  try {
    await Promise.all(ids.map((id) => api.post(`/listings/${id}/publish`)))
    // Optimistically drop them from the queue and decrement the counter.
    reviewListings.value = reviewListings.value.filter(l => !ids.includes(l.id))
    stats.value.pendingReviewListings = Math.max(0, stats.value.pendingReviewListings - ids.length)
  } catch (e) {
    console.error('Publish failed', e)
  } finally {
    for (const id of ids) delete publishing.value[id]
  }
}

async function dismissListing(id) {
  publishing.value[id] = true
  try {
    await api.delete(`/listings/${id}`)
    reviewListings.value = reviewListings.value.filter(l => l.id !== id)
    stats.value.pendingReviewListings = Math.max(0, stats.value.pendingReviewListings - 1)
  } catch (e) {
    console.error('Dismiss failed', e)
  } finally {
    delete publishing.value[id]
  }
}

onMounted(loadStats)
</script>
