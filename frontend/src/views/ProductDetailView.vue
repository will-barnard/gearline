<template>
  <div class="flex flex-col h-full overflow-auto">
    <header class="flex h-16 flex-shrink-0 items-center gap-4 border-b border-gray-800 px-6">
      <router-link to="/products" class="text-gray-500 hover:text-gray-300 transition-colors">← Products</router-link>
      <h1 class="text-lg font-semibold text-white truncate">{{ product?.title || 'Loading…' }}</h1>
    </header>

    <div v-if="loading" class="flex items-center justify-center py-16">
      <div class="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"></div>
    </div>

    <div v-else-if="product" class="flex-1 overflow-auto p-6">
      <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <!-- Product info -->
        <div class="lg:col-span-2 space-y-6">
          <div class="card">
            <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500">Product Details</h2>
            <dl class="grid grid-cols-2 gap-4">
              <div><dt class="text-xs text-gray-500">SKU</dt><dd class="mt-1 font-mono text-sm text-gray-200">{{ product.sku }}</dd></div>
              <div><dt class="text-xs text-gray-500">Brand</dt><dd class="mt-1 text-sm text-gray-200">{{ product.brand || '—' }}</dd></div>
              <div><dt class="text-xs text-gray-500">Category</dt><dd class="mt-1 text-sm text-gray-200">{{ product.category || '—' }}</dd></div>
              <div><dt class="text-xs text-gray-500">Condition</dt><dd class="mt-1"><span class="badge-gray">{{ product.condition }}</span></dd></div>
              <div><dt class="text-xs text-gray-500">Price</dt><dd class="mt-1 text-lg font-bold text-white">${{ product.price }}</dd></div>
              <div><dt class="text-xs text-gray-500">Quantity</dt><dd class="mt-1 text-lg font-bold" :class="product.quantity === 0 ? 'text-red-400' : 'text-white'">{{ product.quantity }}</dd></div>
              <div v-if="product.serialNumber"><dt class="text-xs text-gray-500">Serial Number</dt><dd class="mt-1 font-mono text-sm text-gray-200">{{ product.serialNumber }}</dd></div>
              <div v-if="product.shopifyProductId"><dt class="text-xs text-gray-500">Shopify ID</dt><dd class="mt-1 font-mono text-xs text-gray-400">{{ product.shopifyProductId }}</dd></div>
            </dl>
          </div>

          <div v-if="product.description" class="card">
            <h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">Description</h2>
            <p class="text-sm text-gray-300 leading-relaxed">{{ product.description }}</p>
          </div>
        </div>

        <!-- Listings sidebar -->
        <div class="space-y-4">
          <div class="card">
            <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500">Marketplace Listings</h2>
            <div v-if="listingsLoading" class="space-y-2">
              <div v-for="i in 2" :key="i" class="h-16 animate-pulse rounded-lg bg-gray-800"></div>
            </div>
            <div v-else-if="listings.length === 0" class="py-6 text-center text-sm text-gray-500">
              No listings yet
            </div>
            <div v-else class="space-y-2">
              <div v-for="l in listings" :key="l.id" class="rounded-lg border border-gray-800 p-3">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-medium text-gray-300">{{ l.marketplaceType }}</span>
                  <span :class="listingBadge(l.listingStatus)">{{ l.listingStatus }}</span>
                </div>
                <div v-if="l.syncedPrice" class="mt-1 text-xs text-gray-500">${{ l.syncedPrice }} · qty {{ l.syncedQuantity }}</div>
                <div v-if="l.lastError" class="mt-1 text-xs text-red-400 truncate">{{ l.lastError }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/lib/api'

const route = useRoute()
const product = ref(null)
const listings = ref([])
const loading = ref(true)
const listingsLoading = ref(true)

async function load() {
  try {
    const [p, l] = await Promise.all([
      api.get(`/products/${route.params.id}`),
      api.get(`/listings/product/${route.params.id}`)
    ])
    product.value = p.data
    listings.value = l.data
  } catch (e) { console.error(e) }
  finally { loading.value = false; listingsLoading.value = false }
}

function listingBadge(s) {
  return { ACTIVE: 'badge-green', FAILED: 'badge-red', PENDING: 'badge-yellow', DELISTED: 'badge-gray', SOLD: 'badge-blue' }[s] || 'badge-gray'
}

onMounted(load)
</script>
