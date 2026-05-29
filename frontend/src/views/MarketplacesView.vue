<template>
  <div class="flex flex-col h-full">
    <header class="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-800 px-6">
      <h1 class="text-lg font-semibold text-white">Marketplace Accounts</h1>
    </header>

    <div class="flex-1 overflow-auto p-6 space-y-4">
      <div v-if="loading" class="flex justify-center py-16">
        <div class="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"></div>
      </div>

      <template v-else>
        <div v-if="accounts.length === 0" class="card text-center py-12">
          <p class="text-gray-500 text-sm">No marketplace accounts connected yet.</p>
          <p class="mt-2 text-xs text-gray-600">Connect a marketplace account through the Shopify or Reverb OAuth flows.</p>
        </div>

        <div v-for="account in accounts" :key="account.id" class="card">
          <div class="flex items-start justify-between">
            <div>
              <div class="flex items-center gap-3">
                <span class="badge-blue text-xs">{{ account.marketplaceType }}</span>
                <h3 class="font-semibold text-white">{{ account.displayName }}</h3>
                <span :class="connectionBadge(account.connectionStatus)">{{ account.connectionStatus }}</span>
              </div>
              <p v-if="account.externalShopUrl" class="mt-1 text-xs text-gray-500">{{ account.externalShopUrl }}</p>
              <p v-if="account.lastSyncAt" class="mt-1 text-xs text-gray-600">Last sync: {{ formatDate(account.lastSyncAt) }}</p>
              <p v-if="account.lastError" class="mt-1 text-xs text-red-400">{{ account.lastError }}</p>
            </div>
            <div class="flex items-center gap-2">
              <button
                @click="healthCheck(account.id)"
                :disabled="checking[account.id]"
                class="btn-secondary px-3 py-1.5 text-xs"
              >
                {{ checking[account.id] ? 'Checking…' : 'Health Check' }}
              </button>
              <button
                @click="toggleActive(account)"
                class="btn-secondary px-3 py-1.5 text-xs"
                :class="!account.active ? 'text-green-400' : 'text-red-400'"
              >
                {{ account.active ? 'Disable' : 'Enable' }}
              </button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import api from '@/lib/api'

const accounts = ref([])
const loading = ref(true)
const checking = ref({})

async function load() {
  loading.value = true
  try {
    const res = await api.get('/marketplace/accounts')
    accounts.value = res.data
  } finally { loading.value = false }
}

async function healthCheck(id) {
  checking.value[id] = true
  try {
    await api.post(`/marketplace/accounts/${id}/health-check`)
    load()
  } finally { checking.value[id] = false }
}

async function toggleActive(account) {
  await api.patch(`/marketplace/accounts/${account.id}/toggle`, null, { params: { active: !account.active } })
  load()
}

function connectionBadge(s) {
  return { CONNECTED: 'badge-green', DISCONNECTED: 'badge-gray', TOKEN_EXPIRED: 'badge-yellow', ERROR: 'badge-red', PENDING_OAUTH: 'badge-yellow' }[s] || 'badge-gray'
}

function formatDate(d) { return d ? new Date(d).toLocaleString() : '—' }

onMounted(load)
</script>
