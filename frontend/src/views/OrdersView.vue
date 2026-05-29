<template>
  <div class="flex flex-col h-full">
    <header class="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-800 px-6">
      <h1 class="text-lg font-semibold text-white">Orders</h1>
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
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Order ID</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Marketplace</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Buyer</th>
              <th class="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Total</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Imported</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in orders" :key="o.id" class="table-row">
              <td class="px-4 py-3 font-mono text-xs text-gray-400">{{ o.externalOrderId }}</td>
              <td class="px-4 py-3"><span class="badge-blue">{{ o.marketplaceType }}</span></td>
              <td class="px-4 py-3 text-gray-300">{{ o.buyerInfo?.username || o.buyerInfo?.firstName || '—' }}</td>
              <td class="px-4 py-3 text-right font-medium text-gray-200">
                {{ o.totalAmount ? `$${o.totalAmount}` : '—' }}
              </td>
              <td class="px-4 py-3"><span :class="orderBadge(o.orderStatus)">{{ o.orderStatus }}</span></td>
              <td class="px-4 py-3 text-xs text-gray-500">{{ formatDate(o.importedAt) }}</td>
            </tr>
            <tr v-if="orders.length === 0">
              <td colspan="6" class="px-4 py-12 text-center text-sm text-gray-500">No orders imported yet</td>
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

const orders = ref([])
const loading = ref(true)
const statusFilter = ref('')
const statuses = ['IMPORTED','ACKNOWLEDGED','PROCESSING','SHIPPED','DELIVERED','CANCELLED','REFUNDED','DISPUTED']

async function load() {
  loading.value = true
  try {
    const res = await api.get('/orders', { params: { page: 0, size: 100, status: statusFilter.value || undefined } })
    orders.value = res.data.content
  } finally { loading.value = false }
}

function orderBadge(s) {
  return { IMPORTED: 'badge-yellow', SHIPPED: 'badge-blue', DELIVERED: 'badge-green', CANCELLED: 'badge-red', REFUNDED: 'badge-gray' }[s] || 'badge-gray'
}

function formatDate(d) { return d ? new Date(d).toLocaleString() : '—' }

watch(statusFilter, load)
onMounted(load)
</script>
