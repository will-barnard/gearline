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
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">Marketplace Listings</h2>
              <button
                @click="openPublishModal"
                class="btn-primary px-3 py-1.5 text-xs"
                :disabled="availableAccounts.length === 0"
                :title="availableAccounts.length === 0 ? 'No marketplace accounts connected' : 'Publish to a marketplace'"
              >
                + New Listing
              </button>
            </div>

            <div v-if="listingsLoading" class="space-y-2">
              <div v-for="i in 2" :key="i" class="h-16 animate-pulse rounded-lg bg-gray-800"></div>
            </div>

            <div v-else-if="listings.length === 0" class="py-6 text-center text-sm text-gray-500">
              No listings yet
            </div>

            <div v-else class="space-y-2">
              <div v-for="l in listings" :key="l.id" class="rounded-lg border border-gray-800 p-3">
                <!-- Listing header -->
                <div class="flex items-center justify-between">
                  <span class="text-xs font-medium text-gray-300">{{ l.marketplaceType }}</span>
                  <span :class="listingBadge(l.listingStatus)">{{ l.listingStatus }}</span>
                </div>
                <div v-if="l.syncedPrice" class="mt-1 text-xs text-gray-500">${{ l.syncedPrice }} · qty {{ l.syncedQuantity }}</div>
                <div v-if="l.lastError" class="mt-1 text-xs text-red-400 truncate" :title="l.lastError">{{ l.lastError }}</div>

                <!-- Listing actions -->
                <div class="mt-2 flex items-center gap-2">
                  <button
                    v-if="l.listingStatus !== 'ACTIVE'"
                    @click="publishListing(l)"
                    :disabled="publishingId === l.id"
                    class="text-xs text-brand-400 hover:text-brand-300 disabled:opacity-50"
                  >
                    {{ publishingId === l.id ? 'Publishing…' : 'Publish' }}
                  </button>
                  <button
                    v-if="l.listingStatus === 'ACTIVE'"
                    @click="delistListing(l)"
                    :disabled="delistingId === l.id"
                    class="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-50"
                  >
                    {{ delistingId === l.id ? 'Delisting…' : 'Delist' }}
                  </button>
                  <button
                    @click="toggleOverridesEditor(l.id)"
                    class="text-xs text-gray-500 hover:text-gray-300 ml-auto"
                  >
                    {{ overridesOpen === l.id ? 'Hide overrides ▲' : 'Edit overrides ▼' }}
                  </button>
                </div>

                <!-- Overrides editor (inline expand) -->
                <div v-if="overridesOpen === l.id" class="mt-3 border-t border-gray-800 pt-3 space-y-3">
                  <p class="text-xs text-gray-500">
                    Override specific fields for this channel. Leave blank to use product defaults.
                  </p>

                  <!-- Generic overrides -->
                  <div class="grid grid-cols-2 gap-2">
                    <div>
                      <label class="text-xs text-gray-500">Price override</label>
                      <input v-model="editOverrides[l.id].price" type="number" step="0.01" placeholder="{{ product.price }}" class="input w-full mt-1 py-1 text-xs" />
                    </div>
                    <div>
                      <label class="text-xs text-gray-500">Title override</label>
                      <input v-model="editOverrides[l.id].title" type="text" :placeholder="product.title" class="input w-full mt-1 py-1 text-xs" />
                    </div>
                  </div>

                  <!-- Reverb-specific -->
                  <template v-if="l.marketplaceType === 'REVERB'">
                    <p class="text-xs font-medium text-gray-400">Reverb</p>
                    <div class="grid grid-cols-2 gap-2">
                      <div>
                        <label class="text-xs text-gray-500">Model</label>
                        <input v-model="editOverrides[l.id].reverb_model" placeholder="{{ product.category }}" class="input w-full mt-1 py-1 text-xs" />
                      </div>
                      <div>
                        <label class="text-xs text-gray-500">Year</label>
                        <input v-model="editOverrides[l.id].reverb_year" placeholder="e.g. 1965" class="input w-full mt-1 py-1 text-xs" />
                      </div>
                      <div>
                        <label class="text-xs text-gray-500">Finish</label>
                        <input v-model="editOverrides[l.id].reverb_finish" placeholder="e.g. Sunburst" class="input w-full mt-1 py-1 text-xs" />
                      </div>
                      <div>
                        <label class="text-xs text-gray-500">Shipping profile ID</label>
                        <input v-model="editOverrides[l.id].reverb_shipping_profile_name" placeholder="Numeric profile ID" class="input w-full mt-1 py-1 text-xs" />
                      </div>
                    </div>
                  </template>

                  <!-- eBay-specific -->
                  <template v-if="l.marketplaceType === 'EBAY'">
                    <p class="text-xs font-medium text-gray-400">eBay</p>
                    <div class="grid grid-cols-2 gap-2">
                      <div>
                        <label class="text-xs text-gray-500">Merchant location key</label>
                        <input v-model="editOverrides[l.id].ebay_merchant_location_key" placeholder="Required to publish" class="input w-full mt-1 py-1 text-xs" />
                      </div>
                      <div>
                        <label class="text-xs text-gray-500">Category ID</label>
                        <input v-model="editOverrides[l.id].ebay_category_id" placeholder="eBay leaf category ID" class="input w-full mt-1 py-1 text-xs" />
                      </div>
                      <div>
                        <label class="text-xs text-gray-500">Fulfillment policy ID</label>
                        <input v-model="editOverrides[l.id].ebay_fulfillment_policy_id" placeholder="UUID" class="input w-full mt-1 py-1 text-xs" />
                      </div>
                      <div>
                        <label class="text-xs text-gray-500">Return policy ID</label>
                        <input v-model="editOverrides[l.id].ebay_return_policy_id" placeholder="UUID" class="input w-full mt-1 py-1 text-xs" />
                      </div>
                    </div>
                  </template>

                  <div class="flex items-center gap-2 pt-1">
                    <button
                      @click="saveOverrides(l)"
                      :disabled="savingOverridesId === l.id"
                      class="btn-primary px-3 py-1 text-xs"
                    >
                      {{ savingOverridesId === l.id ? 'Saving…' : 'Save overrides' }}
                    </button>
                    <span v-if="overridesSavedId === l.id" class="text-xs text-green-400">Saved</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Publish modal -->
    <div v-if="showPublishModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div class="w-full max-w-md rounded-xl bg-gray-900 border border-gray-800 shadow-2xl">
        <div class="flex items-center justify-between border-b border-gray-800 px-5 py-4">
          <h3 class="text-sm font-semibold text-white">Publish to Marketplace</h3>
          <button @click="closePublishModal" class="text-gray-500 hover:text-gray-300">✕</button>
        </div>

        <form @submit.prevent="submitPublish" class="p-5 space-y-4">
          <!-- Marketplace account -->
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Marketplace account</label>
            <select v-model="publishForm.accountId" required class="input w-full py-2 text-sm">
              <option value="">Select an account…</option>
              <option v-for="a in availableAccounts" :key="a.id" :value="a.id">
                {{ a.marketplaceType }} — {{ a.shopName || a.id }}
              </option>
            </select>
          </div>

          <!-- Generic overrides -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1">Price override</label>
              <input v-model="publishForm.price" type="number" step="0.01" :placeholder="product.price" class="input w-full py-1.5 text-sm" />
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1">Title override</label>
              <input v-model="publishForm.title" :placeholder="product.title" class="input w-full py-1.5 text-sm" />
            </div>
          </div>

          <!-- Reverb fields (shown when Reverb account selected) -->
          <template v-if="selectedAccountType === 'REVERB'">
            <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Reverb</p>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-1">Model</label>
                <input v-model="publishForm.reverb_model" :placeholder="product.category || product.title" class="input w-full py-1.5 text-sm" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-1">Year</label>
                <input v-model="publishForm.reverb_year" placeholder="e.g. 1965" class="input w-full py-1.5 text-sm" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-1">Finish</label>
                <input v-model="publishForm.reverb_finish" placeholder="e.g. Sunburst" class="input w-full py-1.5 text-sm" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-1">Shipping profile ID</label>
                <input v-model="publishForm.reverb_shipping_profile_name" placeholder="Numeric profile ID" class="input w-full py-1.5 text-sm" />
              </div>
            </div>
          </template>

          <!-- eBay fields (shown when eBay account selected) -->
          <template v-if="selectedAccountType === 'EBAY'">
            <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">eBay</p>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-1">
                  Merchant location key <span class="text-red-400">*</span>
                </label>
                <input v-model="publishForm.ebay_merchant_location_key" required placeholder="Required" class="input w-full py-1.5 text-sm" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-1">Category ID</label>
                <input v-model="publishForm.ebay_category_id" placeholder="eBay leaf category ID" class="input w-full py-1.5 text-sm" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-1">Fulfillment policy ID</label>
                <input v-model="publishForm.ebay_fulfillment_policy_id" placeholder="UUID" class="input w-full py-1.5 text-sm" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-400 mb-1">Return policy ID</label>
                <input v-model="publishForm.ebay_return_policy_id" placeholder="UUID" class="input w-full py-1.5 text-sm" />
              </div>
            </div>
          </template>

          <div v-if="publishError" class="text-xs text-red-400">{{ publishError }}</div>

          <div class="flex justify-end gap-3 pt-2">
            <button type="button" @click="closePublishModal" class="btn-secondary px-4 py-2 text-sm">Cancel</button>
            <button type="submit" :disabled="publishing" class="btn-primary px-4 py-2 text-sm">
              {{ publishing ? 'Publishing…' : 'Create & Publish' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/lib/api'

const route = useRoute()
const product = ref(null)
const listings = ref([])
const accounts = ref([])
const loading = ref(true)
const listingsLoading = ref(true)

// Publish modal state
const showPublishModal = ref(false)
const publishing = ref(false)
const publishError = ref(null)
const publishForm = ref(emptyPublishForm())

// Inline listing actions
const publishingId = ref(null)
const delistingId = ref(null)

// Overrides editor state
const overridesOpen = ref(null)       // listing ID currently open
const editOverrides = ref({})         // { [listingId]: { price, title, reverb_model, … } }
const savingOverridesId = ref(null)
const overridesSavedId = ref(null)

// Computed: only accounts that don't already have a listing for this product
const existingAccountIds = computed(() =>
  new Set(listings.value.map(l => l.marketplaceAccountId))
)
const availableAccounts = computed(() =>
  accounts.value.filter(a => a.active && !existingAccountIds.value.has(a.id))
)
const selectedAccountType = computed(() => {
  const a = accounts.value.find(a => a.id === publishForm.value.accountId)
  return a?.marketplaceType ?? null
})

// ── Data loading ───────────────────────────────────────────────────────────────

async function load() {
  try {
    const [p, l, accs] = await Promise.all([
      api.get(`/products/${route.params.id}`),
      api.get(`/listings/product/${route.params.id}`),
      api.get('/marketplace/accounts'),
    ])
    product.value = p.data
    listings.value = l.data
    accounts.value = accs.data
    // Pre-populate overrides editor state for each listing
    l.data.forEach(listing => {
      editOverrides.value[listing.id] = flattenOverrides(listing)
    })
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
    listingsLoading.value = false
  }
}

// ── Publish modal ──────────────────────────────────────────────────────────────

function openPublishModal() {
  publishForm.value = emptyPublishForm()
  publishError.value = null
  showPublishModal.value = true
}

function closePublishModal() {
  showPublishModal.value = false
}

async function submitPublish() {
  if (!publishForm.value.accountId) return
  publishing.value = true
  publishError.value = null

  try {
    // Step 1: create the listing record with any overrides
    const overrides = buildOverrides(publishForm.value)
    const createRes = await api.post('/listings', {
      productId: product.value.id,
      marketplaceAccountId: publishForm.value.accountId,
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    })
    const listingId = createRes.data.id

    // Step 2: enqueue publish
    await api.post(`/listings/${listingId}/publish`)

    // Refresh listings and close
    const l = await api.get(`/listings/product/${route.params.id}`)
    listings.value = l.data
    l.data.forEach(listing => {
      if (!editOverrides.value[listing.id]) {
        editOverrides.value[listing.id] = flattenOverrides(listing)
      }
    })
    closePublishModal()
  } catch (e) {
    publishError.value = e.response?.data?.message
      || e.response?.data?.error
      || 'Failed to create listing'
  } finally {
    publishing.value = false
  }
}

// ── Listing actions ────────────────────────────────────────────────────────────

async function publishListing(listing) {
  publishingId.value = listing.id
  try {
    await api.post(`/listings/${listing.id}/publish`)
    await refreshListings()
  } catch (e) { console.error(e) }
  finally { publishingId.value = null }
}

async function delistListing(listing) {
  delistingId.value = listing.id
  try {
    await api.post(`/listings/${listing.id}/delist`)
    await refreshListings()
  } catch (e) { console.error(e) }
  finally { delistingId.value = null }
}

// ── Overrides editor ───────────────────────────────────────────────────────────

function toggleOverridesEditor(listingId) {
  overridesOpen.value = overridesOpen.value === listingId ? null : listingId
}

async function saveOverrides(listing) {
  savingOverridesId.value = listing.id
  overridesSavedId.value = null
  try {
    const overrides = buildOverrides(editOverrides.value[listing.id])
    await api.patch(`/listings/${listing.id}/overrides`, { overrides })
    overridesSavedId.value = listing.id
    setTimeout(() => { if (overridesSavedId.value === listing.id) overridesSavedId.value = null }, 2000)
  } catch (e) { console.error(e) }
  finally { savingOverridesId.value = null }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function refreshListings() {
  const l = await api.get(`/listings/product/${route.params.id}`)
  listings.value = l.data
}

function emptyPublishForm() {
  return {
    accountId: '',
    price: '',
    title: '',
    reverb_model: '',
    reverb_year: '',
    reverb_finish: '',
    reverb_shipping_profile_name: '',
    ebay_merchant_location_key: '',
    ebay_category_id: '',
    ebay_fulfillment_policy_id: '',
    ebay_return_policy_id: '',
  }
}

/** Strips blank values and maps form fields to listing_overrides keys */
function buildOverrides(form) {
  const result = {}
  const map = {
    price: 'price',
    title: 'title',
    reverb_model: 'reverb_model',
    reverb_year: 'reverb_year',
    reverb_finish: 'reverb_finish',
    reverb_shipping_profile_name: 'reverb_shipping_profile_name',
    ebay_merchant_location_key: 'ebay_merchant_location_key',
    ebay_category_id: 'ebay_category_id',
    ebay_fulfillment_policy_id: 'ebay_fulfillment_policy_id',
    ebay_return_policy_id: 'ebay_return_policy_id',
  }
  for (const [formKey, overrideKey] of Object.entries(map)) {
    const val = form[formKey]
    if (val !== '' && val != null) result[overrideKey] = val
  }
  return result
}

/** Flattens a listing's listingOverrides map into the flat form shape */
function flattenOverrides(listing) {
  const o = listing.listingOverrides || {}
  return {
    price: o.price ?? '',
    title: o.title ?? '',
    reverb_model: o.reverb_model ?? '',
    reverb_year: o.reverb_year ?? '',
    reverb_finish: o.reverb_finish ?? '',
    reverb_shipping_profile_name: o.reverb_shipping_profile_name ?? '',
    ebay_merchant_location_key: o.ebay_merchant_location_key ?? '',
    ebay_category_id: o.ebay_category_id ?? '',
    ebay_fulfillment_policy_id: o.ebay_fulfillment_policy_id ?? '',
    ebay_return_policy_id: o.ebay_return_policy_id ?? '',
  }
}

function listingBadge(s) {
  return {
    ACTIVE: 'badge-green',
    FAILED: 'badge-red',
    PENDING: 'badge-yellow',
    NEEDS_REVIEW: 'badge-yellow',
    DELISTED: 'badge-gray',
    SOLD: 'badge-blue',
  }[s] || 'badge-gray'
}

onMounted(load)
</script>
