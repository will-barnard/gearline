<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <header class="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-800 px-6">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold text-white">SKU Audit</h1>
        <span v-if="!loading && !error" class="text-xs text-gray-500">
          {{ Number(totalElements || 0).toLocaleString() }} product{{ totalElements !== 1 ? 's' : '' }}
        </span>
      </div>
      <div class="flex items-center gap-3">
        <input
          v-model="searchQuery"
          type="search"
          placeholder="Filter by SKU, title, brand…"
          class="input w-56 py-1.5 text-xs"
        />
        <button
          @click="exportCsv"
          :disabled="exporting"
          class="btn-secondary flex items-center gap-1.5 py-1.5 px-3 text-xs"
          title="Download all products as CSV for external review"
        >
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {{ exporting ? 'Downloading…' : 'Export CSV' }}
        </button>
      </div>
    </header>

    <!-- Info banner -->
    <div class="flex flex-shrink-0 items-start gap-3 border-b border-gray-800 bg-gray-900/60 px-6 py-3 text-xs text-gray-400">
      <svg class="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span>
        Products are sorted alphabetically by SKU so related items group together — mismatches stand out.
        Click any SKU to edit it inline. Changes are saved to Gearline immediately and will propagate to
        marketplace listings on the next sync. SKUs come from Shopify; if you change them here, update
        Shopify too to avoid drift.
      </span>
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
        <div class="overflow-hidden rounded-xl border border-gray-800">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-800 bg-gray-900">
                <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 w-52">
                  SKU
                  <span class="ml-1 text-gray-600 font-normal normal-case tracking-normal">(click to edit)</span>
                </th>
                <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Title</th>
                <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 w-32">Brand</th>
                <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 w-28">Model</th>
                <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 w-20">Year</th>
                <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 w-24">Status</th>
                <th class="px-4 py-3 w-16"></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in products"
                :key="p.id"
                class="border-b border-gray-800/60 hover:bg-gray-800/30 transition-colors"
                :class="editingId === p.id ? 'bg-gray-800/40' : ''"
              >
                <!-- SKU — inline editable -->
                <td class="px-4 py-2.5 font-mono text-xs">
                  <template v-if="editingId === p.id">
                    <div class="flex items-center gap-1">
                      <input
                        v-model="editingSku"
                        @keydown.enter.prevent="saveSku(p)"
                        @keydown.escape.prevent="cancelEdit"
                        ref="skuInput"
                        class="input w-40 py-1 text-xs font-mono"
                        :class="skuError ? 'border-red-500' : ''"
                        :disabled="saving"
                        maxlength="100"
                        spellcheck="false"
                        autocomplete="off"
                      />
                      <button
                        @click="saveSku(p)"
                        :disabled="saving"
                        class="flex-shrink-0 rounded px-1.5 py-1 text-xs bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50"
                        title="Save (Enter)"
                      >{{ saving ? '…' : '✓' }}</button>
                      <button
                        @click="cancelEdit"
                        :disabled="saving"
                        class="flex-shrink-0 rounded px-1.5 py-1 text-xs text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
                        title="Cancel (Esc)"
                      >✕</button>
                    </div>
                    <p v-if="skuError" class="mt-1 text-red-400 text-xs">{{ skuError }}</p>
                  </template>
                  <template v-else>
                    <button
                      @click="startEdit(p)"
                      class="group flex items-center gap-1.5 text-left text-gray-300 hover:text-brand-300 transition-colors"
                      title="Click to edit SKU"
                    >
                      <span>{{ p.sku }}</span>
                      <svg class="h-3 w-3 opacity-0 group-hover:opacity-60 flex-shrink-0 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                  </template>
                </td>

                <!-- Title -->
                <td class="px-4 py-2.5">
                  <span class="text-gray-100 text-xs leading-snug">{{ p.title }}</span>
                </td>

                <!-- Brand -->
                <td class="px-4 py-2.5 text-xs text-gray-400">{{ p.brand || '—' }}</td>

                <!-- Model -->
                <td class="px-4 py-2.5 text-xs text-gray-400">{{ p.model || '—' }}</td>

                <!-- Year -->
                <td class="px-4 py-2.5 text-xs text-gray-500 tabular-nums">{{ p.yearMade || '—' }}</td>

                <!-- Status -->
                <td class="px-4 py-2.5">
                  <span
                    v-if="p.marketplaceExcluded"
                    class="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-orange-900/40 text-orange-300 border border-orange-700/30"
                  >Excluded</span>
                  <span v-else :class="statusBadge(p.status)">{{ p.status }}</span>
                </td>

                <!-- View link -->
                <td class="px-4 py-2.5 text-right">
                  <router-link :to="`/products/${p.id}`" class="text-xs text-brand-400 hover:text-brand-300">
                    View →
                  </router-link>
                </td>
              </tr>

              <!-- Empty state -->
              <tr v-if="products.length === 0">
                <td colspan="7" class="px-4 py-16 text-center text-sm text-gray-500">
                  No products match your filter.
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
import { ref, watch, onMounted, nextTick } from 'vue'
import api from '@/lib/api'

const products = ref([])
const loading = ref(true)
const error = ref(null)
const page = ref(0)
const totalPages = ref(1)
const totalElements = ref(0)
const searchQuery = ref('')
const exporting = ref(false)

// Inline SKU editing state
const editingId = ref(null)
const editingSku = ref('')
const skuError = ref(null)
const saving = ref(false)
const skuInput = ref(null)

// Debounce search
let searchTimeout = null
watch(searchQuery, () => {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => { page.value = 0; loadProducts() }, 300)
})

async function loadProducts() {
  loading.value = true
  error.value = null
  try {
    const res = await api.get('/products', {
      params: {
        page: page.value,
        size: 200,
        sortBy: 'sku',
        sortDir: 'asc',
        search: searchQuery.value || undefined,
      }
    })
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

// ── Inline SKU editing ────────────────────────────────────────────────────────

function startEdit(product) {
  editingId.value = product.id
  editingSku.value = product.sku
  skuError.value = null
  nextTick(() => {
    if (skuInput.value) {
      const el = Array.isArray(skuInput.value) ? skuInput.value[0] : skuInput.value
      el?.focus()
      el?.select()
    }
  })
}

function cancelEdit() {
  editingId.value = null
  editingSku.value = ''
  skuError.value = null
}

async function saveSku(product) {
  const newSku = editingSku.value.trim()
  skuError.value = null

  if (!newSku) {
    skuError.value = 'SKU cannot be blank'
    return
  }
  if (newSku === product.sku) {
    cancelEdit()
    return
  }
  if (newSku.length > 100) {
    skuError.value = 'SKU must be 100 characters or fewer'
    return
  }

  saving.value = true
  try {
    const res = await api.put(`/products/${product.id}`, { sku: newSku })
    // Update the local list in place so the row re-renders without a full reload
    const idx = products.value.findIndex(p => p.id === product.id)
    if (idx !== -1) {
      products.value[idx] = { ...products.value[idx], sku: res.data.sku }
    }
    cancelEdit()
  } catch (e) {
    if (e.response?.status === 409) {
      skuError.value = 'That SKU is already used by another product'
    } else {
      skuError.value = 'Failed to save — please try again'
    }
  } finally {
    saving.value = false
  }
}

// ── CSV export ─────────────────────────────────────────────────────────────────

async function exportCsv() {
  exporting.value = true
  try {
    const res = await api.get('/products/export.csv', { responseType: 'blob' })
    const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `gearline-products-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    alert('CSV export failed — please try again.')
    console.error(e)
  } finally {
    exporting.value = false
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(s) {
  return { ACTIVE: 'badge-green', INACTIVE: 'badge-yellow', ARCHIVED: 'badge-gray', DELETED: 'badge-red' }[s] || 'badge-gray'
}

watch(page, loadProducts)
onMounted(loadProducts)
</script>
