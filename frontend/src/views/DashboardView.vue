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
          <p class="text-xs text-gray-500">Review each listing's overrides, then click Publish.</p>
        </div>

        <div v-if="reviewLoading" class="flex justify-center py-6">
          <div class="h-6 w-6 animate-spin rounded-full border-2 border-amber-400 border-t-transparent"></div>
        </div>

        <div v-else-if="reviewListings.length > 0" class="overflow-hidden rounded-lg border border-gray-800">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-800 bg-gray-900">
                <th class="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Product</th>
                <th class="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Marketplace</th>
                <th class="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Price</th>
                <th class="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Qty</th>
                <th class="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Since</th>
                <th class="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in reviewListings" :key="l.id" class="table-row">
                <td class="px-4 py-3">
                  <router-link
                    :to="`/products/${l.productId}`"
                    class="text-sm text-white hover:text-brand-400 transition-colors font-medium"
                  >{{ l.productTitle || l.productSku || l.productId }}</router-link>
                  <p v-if="l.productSku" class="text-xs text-gray-500 font-mono mt-0.5">{{ l.productSku }}</p>
                </td>
                <td class="px-4 py-3">
                  <span class="badge-blue">{{ l.marketplaceType }}</span>
                </td>
                <td class="px-4 py-3 text-right text-gray-200 text-xs">
                  {{ formatPrice(l.syncedPrice ?? l.productPrice) }}
                </td>
                <td class="px-4 py-3 text-right text-gray-200 text-xs">
                  {{ l.syncedQuantity ?? l.productQuantity ?? '—' }}
                </td>
                <td class="px-4 py-3 text-xs text-gray-500">{{ formatDate(l.createdAt) }}</td>
                <td class="px-4 py-3 text-right">
                  <div class="flex items-center justify-end gap-3">
                    <button
                      @click="dismissListing(l.id)"
                      :disabled="publishing[l.id]"
                      class="text-xs text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50"
                      title="Remove from review queue without publishing"
                    >Archive</button>
                    <router-link
                      :to="`/products/${l.productId}`"
                      class="text-xs text-gray-400 hover:text-white transition-colors"
                    >Configure</router-link>
                    <button
                      @click="publishListing(l.id)"
                      :disabled="publishing[l.id]"
                      class="rounded px-3 py-1 text-xs font-medium bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50 transition-colors"
                    >
                      {{ publishing[l.id] ? 'Queued…' : 'Publish' }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
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
import { ref, onMounted } from 'vue'
import api from '@/lib/api'
import StatCard from '@/components/dashboard/StatCard.vue'
import HealthRow from '@/components/dashboard/HealthRow.vue'

const stats = ref({
  totalProducts: 0, activeListings: 0, failedListings: 0, pendingReviewListings: 0,
  totalOrders: 0, failedSyncJobs: 0, inProgressSyncJobs: 0, connectedAccounts: 0
})
const loading = ref(true)
const refreshedAt = ref('—')

// Review queue state
const reviewListings = ref([])
const reviewLoading = ref(false)
const publishing = ref({})

async function loadStats() {
  loading.value = true
  try {
    const res = await api.get('/admin/dashboard/stats')
    stats.value = res.data
    refreshedAt.value = new Date().toLocaleTimeString()
    // Load the review queue whenever stats say there's something pending
    if (res.data.pendingReviewListings > 0) {
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
    const res = await api.get('/listings', { params: { status: 'NEEDS_REVIEW', page: 0, size: 50 } })
    reviewListings.value = res.data.content
  } catch (e) {
    console.error('Failed to load review queue', e)
  } finally {
    reviewLoading.value = false
  }
}

async function publishListing(id) {
  publishing.value[id] = true
  try {
    await api.post(`/listings/${id}/publish`)
    // Optimistically remove from queue and decrement counter
    reviewListings.value = reviewListings.value.filter(l => l.id !== id)
    stats.value.pendingReviewListings = Math.max(0, stats.value.pendingReviewListings - 1)
  } catch (e) {
    console.error('Publish failed', e)
  } finally {
    delete publishing.value[id]
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

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatPrice(v) {
  if (v == null) return '—'
  return '$' + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

onMounted(loadStats)
</script>
