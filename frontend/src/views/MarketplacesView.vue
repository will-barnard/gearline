<template>
  <div class="flex flex-col h-full">
    <header class="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-800 px-6">
      <h1 class="text-lg font-semibold text-white">Marketplace Accounts</h1>
      <button @click="showConnectModal = true" class="btn-primary px-3 py-1.5 text-sm">
        + Connect Shopify
      </button>
    </header>

    <!-- Connection success / error banners -->
    <div v-if="connectionResult === 'true'" class="mx-6 mt-4 rounded-lg bg-green-900/40 border border-green-700 px-4 py-3 text-sm text-green-300">
      Shopify store connected successfully. Webhooks have been registered.
    </div>
    <div v-if="connectionResult === 'false'" class="mx-6 mt-4 rounded-lg bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
      Shopify connection failed{{ connectionError ? ': ' + connectionError : '.' }} Please try again.
    </div>

    <div class="flex-1 overflow-auto p-6 space-y-4">
      <div v-if="loading" class="flex justify-center py-16">
        <div class="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"></div>
      </div>

      <template v-else>
        <div v-if="accounts.length === 0" class="card text-center py-12">
          <p class="text-gray-500 text-sm">No marketplace accounts connected yet.</p>
          <p class="mt-2 text-xs text-gray-600">Click <span class="text-gray-400">+ Connect Shopify</span> to link your store, or connect Reverb / eBay via their OAuth flows.</p>
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

    <!-- Connect Shopify modal -->
    <div v-if="showConnectModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div class="card w-full max-w-md p-6">
        <h2 class="text-base font-semibold text-white mb-4">Connect Shopify Store</h2>

        <p class="text-sm text-gray-400 mb-4">
          Enter your Shopify store domain. You'll be redirected to Shopify to authorise the connection.
        </p>

        <div class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Store domain</label>
            <div class="flex items-center rounded-lg bg-gray-800 border border-gray-700 focus-within:border-brand-500 overflow-hidden">
              <input
                v-model="shopDomain"
                type="text"
                placeholder="mystore"
                class="flex-1 bg-transparent px-3 py-2 text-sm text-white placeholder-gray-600 outline-none"
                @keydown.enter="connectShopify"
              />
              <span class="pr-3 text-sm text-gray-500 select-none">.myshopify.com</span>
            </div>
            <p v-if="domainError" class="mt-1 text-xs text-red-400">{{ domainError }}</p>
          </div>
        </div>

        <div class="mt-6 flex gap-3 justify-end">
          <button @click="closeConnectModal" class="btn-secondary px-4 py-2 text-sm">Cancel</button>
          <button @click="connectShopify" :disabled="connecting" class="btn-primary px-4 py-2 text-sm">
            {{ connecting ? 'Redirecting…' : 'Connect' }}
          </button>
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
const accounts = ref([])
const loading = ref(true)
const checking = ref({})
const showConnectModal = ref(false)
const shopDomain = ref('')
const domainError = ref('')
const connecting = ref(false)

// Surface the result of a Shopify OAuth redirect
const connectionResult = ref(route.query.shopify_connected || null)
const connectionError = ref(route.query.error || null)

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

function connectShopify() {
  domainError.value = ''
  const raw = shopDomain.value.trim()
  if (!raw) {
    domainError.value = 'Please enter your store name.'
    return
  }
  // Accept bare name ("mystore") or full domain ("mystore.myshopify.com")
  const domain = raw.endsWith('.myshopify.com') ? raw : raw + '.myshopify.com'
  const domainPattern = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/
  if (!domainPattern.test(domain)) {
    domainError.value = 'Invalid store name. Use letters, numbers, and hyphens only.'
    return
  }
  connecting.value = true
  // Navigate the browser directly to the install endpoint — it returns a 302 to Shopify
  const installUrl = `${import.meta.env.VITE_API_BASE_URL || ''}/api/v1/marketplace/shopify/oauth/install?shop=${encodeURIComponent(domain)}`
  window.location.href = installUrl
}

function closeConnectModal() {
  showConnectModal.value = false
  shopDomain.value = ''
  domainError.value = ''
  connecting.value = false
}

function connectionBadge(s) {
  return { CONNECTED: 'badge-green', DISCONNECTED: 'badge-gray', TOKEN_EXPIRED: 'badge-yellow', ERROR: 'badge-red', PENDING_OAUTH: 'badge-yellow' }[s] || 'badge-gray'
}

function formatDate(d) { return d ? new Date(d).toLocaleString() : '—' }

onMounted(load)
</script>
