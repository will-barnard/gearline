<template>
  <div class="flex flex-col h-full">
    <header class="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-800 px-6">
      <h1 class="text-lg font-semibold text-white">Products</h1>
      <div class="flex items-center gap-3">
        <input
          v-model="searchQuery"
          type="search"
          placeholder="Search title, SKU, brand…"
          class="input w-56 py-1.5 text-xs"
        />
        <select v-model="statusFilter" class="input w-40 py-1.5 text-xs">
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
          <option value="ARCHIVED">Archived</option>
        </select>
      </div>
    </header>

    <div class="flex-1 overflow-auto p-6">
      <!-- Loading -->
      <div v-if="loading" class="flex items-center justify-center py-16">
        <div class="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"></div>
      </div>

      <!-- Error -->
      <div v-else-if="error" class="rounded-lg border border-red-800 bg-red-900/30 p-4 text-sm text-red-400">
        {{ error }}
      </div>

      <!-- Table -->
      <div v-else class="overflow-hidden rounded-xl border border-gray-800">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 bg-gray-900">
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
            <tr v-for="p in products" :key="p.id" class="table-row">
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
                <span :class="statusBadge(p.status)">{{ p.status }}</span>
              </td>
              <td class="px-4 py-3 text-right">
                <router-link :to="`/products/${p.id}`" class="text-xs text-brand-400 hover:text-brand-300">
                  View →
                </router-link>
              </td>
            </tr>
            <tr v-if="products.length === 0">
              <td colspan="8" class="px-4 py-12 text-center text-sm text-gray-500">No products found</td>
            </tr>
          </tbody>
        </table>

        <!-- Pagination -->
        <div v-if="totalPages > 1" class="flex items-center justify-between border-t border-gray-800 px-4 py-3">
          <span class="text-xs text-gray-500">{{ totalElements }} products</span>
          <div class="flex gap-2">
            <button @click="page--" :disabled="page === 0" class="btn-secondary px-3 py-1 text-xs">←</button>
            <span class="px-3 py-1 text-xs text-gray-400">{{ page + 1 }} / {{ totalPages }}</span>
            <button @click="page++" :disabled="page >= totalPages - 1" class="btn-secondary px-3 py-1 text-xs">→</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import api from '@/lib/api'

const products = ref([])
const loading = ref(true)
const error = ref(null)
const page = ref(0)
const totalPages = ref(1)
const totalElements = ref(0)
const statusFilter = ref('')
const searchQuery = ref('')

// Debounce search so we don't fire on every keystroke
let searchTimeout = null
watch(searchQuery, () => {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => { page.value = 0; loadProducts() }, 300)
})

async function loadProducts() {
  loading.value = true; error.value = null
  try {
    const res = await api.get('/products', {
      params: {
        page: page.value,
        size: 50,
        status: statusFilter.value || undefined,
        search: searchQuery.value || undefined,
      }
    })
    products.value = res.data.content
    totalPages.value = res.data.totalPages
    totalElements.value = res.data.totalElements
  } catch (e) { error.value = 'Failed to load products' }
  finally { loading.value = false }
}

function statusBadge(s) {
  return { ACTIVE: 'badge-green', INACTIVE: 'badge-yellow', ARCHIVED: 'badge-gray', DELETED: 'badge-red' }[s] || 'badge-gray'
}

watch([page, statusFilter], loadProducts)
onMounted(loadProducts)
</script>
