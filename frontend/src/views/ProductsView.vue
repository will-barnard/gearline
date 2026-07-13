<template>
  <div class="flex flex-col h-full">
    <header class="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-800 px-6">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold text-white">Products</h1>
        <span v-if="!loading && !error && totalElements > 0" class="text-xs text-gray-500">
          {{ Number(totalElements || 0).toLocaleString() }}
          {{ activeFilter === 'excluded' ? 'excluded' : activeFilter === 'archived' ? 'archived' : activeFilter === 'active' ? 'active' : '' }}
          product{{ totalElements !== 1 ? 's' : '' }}
        </span>
      </div>
      <div class="flex items-center gap-3">
        <router-link
          to="/products/sku-audit"
          class="btn-secondary flex items-center gap-1.5 py-1.5 px-3 text-xs text-gray-400 hover:text-white"
          title="Review and fix mismatched SKUs"
        >
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          SKU Audit
        </router-link>
        <input
          v-model="searchQuery"
          type="search"
          placeholder="Search title, SKU, brand…"
          class="input w-56 py-1.5 text-xs"
        />
        <!-- Filter tabs -->
        <div class="flex items-center rounded-lg bg-gray-800 border border-gray-700 overflow-hidden text-xs">
          <button
            @click="setFilter('all')"
            :class="activeFilter === 'all' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'"
            class="px-3 py-1.5 transition-colors"
          >All</button>
          <button
            @click="setFilter('active')"
            :class="activeFilter === 'active' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'"
            class="px-3 py-1.5 border-l border-gray-700 transition-colors"
          >Active</button>
          <button
            @click="setFilter('archived')"
            :class="activeFilter === 'archived' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'"
            class="px-3 py-1.5 border-l border-gray-700 transition-colors"
          >Archived</button>
          <button
            @click="setFilter('excluded')"
            :class="activeFilter === 'excluded' ? 'bg-orange-600 text-white' : 'text-gray-400 hover:text-orange-300'"
            class="px-3 py-1.5 border-l border-gray-700 transition-colors"
            title="Products excluded from eBay and Reverb (Shopify-only)"
          >Excluded</button>
        </div>
      </div>
    </header>

    <!-- Bulk action bar — slides in when items are selected -->
    <div
      v-if="selected.size > 0"
      class="flex flex-shrink-0 items-center gap-4 border-b border-orange-800/60 bg-orange-950/40 px-6 py-2.5"
    >
      <span class="text-sm text-orange-300 font-medium">{{ selected.size }} selected</span>
      <button
        v-if="activeFilter !== 'excluded'"
        @click="bulkExclude(true)"
        :disabled="bulkWorking"
        class="btn-secondary px-3 py-1 text-xs text-orange-400 border-orange-700/50 hover:border-orange-500"
        title="Remove from eBay/Reverb review queue — Shopify listing is unaffected"
      >
        {{ bulkWorking ? 'Working…' : '✕ Exclude from marketplaces' }}
      </button>
      <button
        v-if="activeFilter === 'excluded'"
        @click="bulkExclude(false)"
        :disabled="bulkWorking"
        class="btn-secondary px-3 py-1 text-xs text-green-400 border-green-700/50 hover:border-green-500"
      >
        {{ bulkWorking ? 'Working…' : '↩ Re-include on marketplaces' }}
      </button>
      <button @click="clearSelection" class="text-xs text-gray-500 hover:text-gray-300 ml-auto">
        Clear selection
      </button>
    </div>

    <div class="flex-1 overflow-auto p-6">
      <!-- Loading -->
      <div v-if="loading" class="flex items-center justify-center py-16">
        <div class="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"></div>
      </div>

      <!-- Error -->
      <div v-else-if="error" class="rounded-lg border border-red-800 bg-red-900/30 p-4 text-sm text-red-400">
        {{ error }}
      </div>

      <template v-else>
        <!-- Excluded tab explanation -->
        <div v-if="activeFilter === 'excluded' && products.length > 0"
             class="mb-4 rounded-lg bg-orange-950/40 border border-orange-800/50 px-4 py-3 text-xs text-orange-300">
          These products are <strong class="text-orange-200">excluded from eBay and Reverb</strong>.
          They still live in Shopify and Gearline — they just won't appear in your marketplace review queue.
          Select items and click "↩ Re-include" to restore them.
        </div>

        <!-- Table -->
        <div class="overflow-hidden rounded-xl border border-gray-800">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-800 bg-gray-900">
                <th class="w-10 px-3 py-3">
                  <input
                    type="checkbox"
                    :checked="allSelected"
                    @change="toggleSelectAll"
                    class="rounded border-gray-600 bg-gray-800 text-brand-500 cursor-pointer"
                    title="Select all on this page"
                  />
                </th>
                <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">SKU</th>
                <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Title</th>
                <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Brand</th>
                <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Condition</th>
                <th class="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Price</th>
                <th class="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Qty</th>
                <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                <th class="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in products"
                :key="p.id"
                class="table-row"
                :class="selected.has(p.id) ? 'bg-gray-800/50' : ''"
              >
                <td class="w-10 px-3 py-3">
                  <input
                    type="checkbox"
                    :checked="selected.has(p.id)"
                    @change="toggleSelect(p.id)"
                    class="rounded border-gray-600 bg-gray-800 text-brand-500 cursor-pointer"
                  />
                </td>
                <td class="px-4 py-3 font-mono text-xs text-gray-400">{{ p.sku }}</td>
                <td class="px-4 py-3">
                  <router-link :to="`/products/${p.id}`" class="font-medium text-gray-100 hover:text-brand-400 transition-colors">
                    {{ p.title }}
                  </router-link>
                </td>
                <td class="px-4 py-3 text-gray-400">{{ p.brand || '—' }}</td>
                <td class="px-4 py-3">
                  <span class="badge-gray">{{ p.condition }}</span>
                </td>
                <td class="px-4 py-3 text-right font-medium text-gray-200">${{ p.price }}</td>
                <td class="px-4 py-3 text-right font-medium" :class="p.quantity === 0 ? 'text-red-400' : 'text-gray-200'">
                  {{ p.quantity }}
                </td>
                <td class="px-4 py-3">
                  <!-- On the excluded tab we just show EXCLUDED prominently instead of status -->
                  <span v-if="activeFilter === 'excluded'"
                        class="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-orange-900/50 text-orange-300 border border-orange-700/40">
                    Excluded
                  </span>
                  <span v-else :class="statusBadge(p.status)">{{ p.status }}</span>
                </td>
                <td class="px-4 py-3 text-right">
                  <div class="flex items-center justify-end gap-3">
                    <router-link :to="`/products/${p.id}`" class="text-xs text-brand-400 hover:text-brand-300">
                      View →
                    </router-link>
                    <!-- Exclude / re-include inline actions -->
                    <button
                      v-if="activeFilter === 'excluded'"
                      @click="quickInclude(p)"
                      class="text-xs text-green-500 hover:text-green-400"
                      title="Re-include on eBay/Reverb"
                    >Re-include</button>
                    <button
                      v-else
                      @click="quickExclude(p)"
                      class="text-xs text-orange-500 hover:text-orange-400"
                      title="Remove from eBay/Reverb — Shopify unaffected"
                    >Exclude</button>
                    <button
                      v-if="p.status !== 'ARCHIVED' && activeFilter !== 'excluded'"
                      @click="archiveProduct(p)"
                      class="text-xs text-red-500 hover:text-red-400"
                      title="Archive product"
                    >Archive</button>
                  </div>
                </td>
              </tr>
              <tr v-if="products.length === 0">
                <td colspan="9" class="px-4 py-16 text-center text-sm text-gray-500">
                  <template v-if="activeFilter === 'excluded'">
                    <p class="font-medium text-gray-400 mb-2">No excluded products yet</p>
                    <p class="text-xs text-gray-600 max-w-xs mx-auto">
                      Select deposit listings, restoration placeholders, or any Shopify-only items
                      and click "Exclude from marketplaces" to keep them out of your eBay/Reverb review queue.
                    </p>
                  </template>
                  <template v-else>No products found</template>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- Pagination -->
          <div class="flex items-center justify-between border-t border-gray-800 px-4 py-3">
            <span class="text-xs text-gray-500">
              {{ Number(totalElements || 0).toLocaleString() }} total
              <template v-if="totalPages > 1"> — page {{ page + 1 }} of {{ totalPages }}</template>
            </span>
            <div v-if="totalPages > 1" class="flex gap-2">
              <button @click="page--" :disabled="page === 0" class="btn-secondary px-3 py-1 text-xs">←</button>
              <span class="px-3 py-1 text-xs text-gray-400">{{ page + 1 }} / {{ totalPages }}</span>
              <button @click="page++" :disabled="page >= totalPages - 1" class="btn-secondary px-3 py-1 text-xs">→</button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import api from '@/lib/api'

const products = ref([])
const loading = ref(true)
const error = ref(null)
const page = ref(0)
const totalPages = ref(1)
const totalElements = ref(0)
const activeFilter = ref('all') // 'all' | 'active' | 'archived' | 'excluded'
const searchQuery = ref('')

// Bulk selection — plain ref wrapping a Set; reassign to trigger reactivity
const selected = ref(new Set())
const bulkWorking = ref(false)

// Debounce search
let searchTimeout = null
watch(searchQuery, () => {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => { page.value = 0; loadProducts() }, 300)
})

const allSelected = computed(() =>
  products.value.length > 0 && products.value.every(p => selected.value.has(p.id))
)
const someSelected = computed(() =>
  selected.value.size > 0 && !allSelected.value
)

function setFilter(f) {
  activeFilter.value = f
  page.value = 0
  clearSelection()
  loadProducts()
}

async function loadProducts() {
  loading.value = true; error.value = null
  try {
    const params = {
      page: page.value,
      size: 100,
      search: searchQuery.value || undefined,
    }

    // ── Filter logic ──────────────────────────────────────────────────────────
    // "All", "Active", and "Archived" always hide marketplace_excluded products
    // so that deposit listings and restoration placeholders don't pollute the
    // main product list. The "Excluded" tab is the only place they appear.
    if (activeFilter.value === 'active')   { params.status = 'ACTIVE';   params.marketplaceExcluded = false }
    if (activeFilter.value === 'archived') { params.status = 'ARCHIVED'; params.marketplaceExcluded = false }
    if (activeFilter.value === 'excluded') { params.marketplaceExcluded = true }
    if (activeFilter.value === 'all')      { params.marketplaceExcluded = false }

    const res = await api.get('/products', { params })
    products.value = res.data.content || []
    totalPages.value = res.data.totalPages || 1
    totalElements.value = res.data.totalElements || 0
  } catch (e) {
    error.value = 'Failed to load products'
    console.error(e)
  } finally {
    loading.value = false
  }
}

// ── Selection ─────────────────────────────────────────────────────────────────

function toggleSelect(id) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function toggleSelectAll() {
  if (allSelected.value) {
    selected.value = new Set()
  } else {
    selected.value = new Set(products.value.map(p => p.id))
  }
}

function clearSelection() {
  selected.value = new Set()
}

// ── Exclusion ─────────────────────────────────────────────────────────────────

async function quickExclude(product) {
  if (!confirm(
    `Exclude "${product.title}" from eBay and Reverb?\n\n` +
    `The product stays in Shopify and Gearline exactly as-is. ` +
    `Only marketplace listing creation is suppressed.`
  )) return
  try {
    await api.patch(`/products/${product.id}/marketplace-excluded`, { excluded: true })
    // Remove from the current (non-excluded) view immediately
    products.value = products.value.filter(p => p.id !== product.id)
    totalElements.value = Math.max(0, totalElements.value - 1)
    clearSelection()
  } catch (e) {
    alert('Failed to exclude product.')
  }
}

async function quickInclude(product) {
  try {
    await api.patch(`/products/${product.id}/marketplace-excluded`, { excluded: false })
    // Remove from the excluded view
    products.value = products.value.filter(p => p.id !== product.id)
    totalElements.value = Math.max(0, totalElements.value - 1)
    clearSelection()
  } catch (e) {
    alert('Failed to re-include product.')
  }
}

async function bulkExclude(excluded) {
  const ids = [...selected.value]
  const noun = ids.length === 1 ? 'product' : 'products'
  const verb = excluded ? 'exclude from' : 're-include on'
  if (!confirm(`${excluded ? 'Exclude' : 'Re-include'} ${ids.length} ${noun} ${verb} eBay and Reverb?`)) return

  bulkWorking.value = true
  try {
    await api.post('/products/bulk-marketplace-excluded', { productIds: ids, excluded })
    clearSelection()
    await loadProducts()
  } catch (e) {
    alert(`Failed to update ${ids.length} ${noun}.`)
  } finally {
    bulkWorking.value = false
  }
}

// ── Archive ───────────────────────────────────────────────────────────────────

async function archiveProduct(product) {
  if (!confirm(`Archive "${product.title}"? This will delist it from any active marketplaces.`)) return
  try {
    await api.delete(`/products/${product.id}`)
    products.value = products.value.filter(p => p.id !== product.id)
    totalElements.value = Math.max(0, totalElements.value - 1)
  } catch (e) {
    alert('Failed to archive product. You may need admin permissions.')
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(s) {
  return { ACTIVE: 'badge-green', INACTIVE: 'badge-yellow', ARCHIVED: 'badge-gray', DELETED: 'badge-red' }[s] || 'badge-gray'
}

watch(page, loadProducts)
onMounted(loadProducts)
</script>
