<template>
  <div class="flex flex-col h-full">
    <header class="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-800 px-6">
      <h1 class="text-lg font-semibold text-white">Marketplace Accounts</h1>
      <div class="flex items-center gap-2">
        <button @click="showConnectModal = 'shopify'" class="btn-primary px-3 py-1.5 text-sm">
          + Connect Shopify
        </button>
        <button @click="connectEbay" class="btn-secondary px-3 py-1.5 text-sm">
          + Connect eBay
        </button>
        <button @click="showConnectModal = 'reverb'" class="btn-secondary px-3 py-1.5 text-sm">
          + Connect Reverb
        </button>
      </div>
    </header>

    <!-- Connection success / error banners -->
    <div v-if="shopifyConnected === 'true'" class="mx-6 mt-4 rounded-lg bg-green-900/40 border border-green-700 px-4 py-3 text-sm text-green-300">
      Shopify store connected successfully. Webhooks have been registered.
    </div>
    <div v-if="shopifyConnected === 'false'" class="mx-6 mt-4 rounded-lg bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
      Shopify connection failed{{ connectionError ? ': ' + connectionError : '.' }} Please try again.
    </div>
    <div v-if="ebayConnected === 'true'" class="mx-6 mt-4 rounded-lg bg-green-900/40 border border-green-700 px-4 py-3 text-sm text-green-300">
      eBay account connected successfully.
    </div>
    <div v-if="ebayConnected === 'false'" class="mx-6 mt-4 rounded-lg bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
      eBay connection failed{{ connectionError ? ': ' + connectionError : '.' }} Please try again.
    </div>

    <div class="flex-1 overflow-auto p-6 space-y-8">
      <!-- ── Accounts ─────────────────────────────────────────────────────── -->
      <section>
        <div v-if="loading" class="flex justify-center py-16">
          <div class="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"></div>
        </div>

        <template v-else>
          <div v-if="accounts.length === 0" class="card text-center py-12">
            <p class="text-gray-500 text-sm">No marketplace accounts connected yet.</p>
            <p class="mt-2 text-xs text-gray-600">Click one of the <span class="text-gray-400">+ Connect</span> buttons above to link an account.</p>
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
                <!-- Pricing profile badge -->
                <div class="mt-2 flex items-center gap-2">
                  <span v-if="account.pricingProfileName" class="text-xs text-brand-400">
                    ⬗ {{ account.pricingProfileName }}
                  </span>
                  <button
                    @click="openAssignProfile(account)"
                    class="text-xs text-gray-500 hover:text-gray-300 underline underline-offset-2"
                  >
                    {{ account.pricingProfileName ? 'Change profile' : 'Assign pricing profile' }}
                  </button>
                  <button
                    v-if="account.pricingProfileId"
                    @click="clearProfile(account)"
                    class="text-xs text-red-500 hover:text-red-400 underline underline-offset-2"
                  >
                    Remove
                  </button>
                </div>

                <!-- Excluded tags (Shopify only) -->
                <div v-if="account.marketplaceType === 'SHOPIFY'" class="mt-2">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs text-gray-500">Excluded tags:</span>
                    <template v-if="account.excludedTags && account.excludedTags.length">
                      <span
                        v-for="tag in account.excludedTags"
                        :key="tag"
                        class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-gray-700 text-gray-300"
                      >
                        {{ tag }}
                      </span>
                    </template>
                    <span v-else class="text-xs text-gray-600 italic">none</span>
                    <button
                      @click="openTagEditor(account)"
                      class="text-xs text-gray-500 hover:text-gray-300 underline underline-offset-2"
                    >
                      Edit
                    </button>
                  </div>
                </div>

                <!-- Description suffix (all marketplace types) -->
                <div class="mt-2 flex items-start gap-2">
                  <span class="text-xs text-gray-500 shrink-0 mt-0.5">Description suffix:</span>
                  <span
                    v-if="account.descriptionSuffix"
                    class="text-xs text-gray-400 italic truncate max-w-xs"
                    :title="account.descriptionSuffix"
                  >{{ account.descriptionSuffix }}</span>
                  <span v-else class="text-xs text-gray-600 italic">none</span>
                  <button
                    @click="openSuffixEditor(account)"
                    class="text-xs text-gray-500 hover:text-gray-300 underline underline-offset-2 shrink-0"
                  >Edit</button>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <button
                  v-if="account.marketplaceType === 'SHOPIFY'"
                  @click="syncProducts(account)"
                  :disabled="syncing[account.id]"
                  class="btn-secondary px-3 py-1.5 text-xs text-brand-400"
                  title="Import all existing products from this Shopify store"
                >
                  {{ syncing[account.id] ? 'Syncing…' : 'Sync Products' }}
                </button>
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
      </section>

      <!-- ── Pricing Profiles ───────────────────────────────────────────── -->
      <section>
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-sm font-semibold text-gray-300">Pricing Profiles</h2>
          <button @click="showProfileForm = true" class="btn-secondary px-3 py-1.5 text-xs">
            + New Profile
          </button>
        </div>

        <div v-if="profilesLoading" class="flex justify-center py-8">
          <div class="h-6 w-6 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"></div>
        </div>

        <template v-else>
          <div v-if="profiles.length === 0" class="card text-center py-8">
            <p class="text-gray-500 text-sm">No pricing profiles yet.</p>
            <p class="mt-1 text-xs text-gray-600">Create a profile to automatically adjust prices when syncing to a marketplace.</p>
          </div>

          <div v-for="profile in profiles" :key="profile.id" class="card mb-3">
            <div class="flex items-center justify-between">
              <div>
                <div class="flex items-center gap-3">
                  <h3 class="font-semibold text-white text-sm">{{ profile.name }}</h3>
                  <span :class="profile.active ? 'badge-green' : 'badge-gray'" class="text-xs">
                    {{ profile.active ? 'Active' : 'Inactive' }}
                  </span>
                </div>
                <p class="mt-1 text-xs text-gray-400">
                  {{ formatAdjustment(profile.adjustmentPercent) }} relative to product price
                </p>
              </div>
              <div class="flex items-center gap-2">
                <button @click="editProfile(profile)" class="btn-secondary px-3 py-1.5 text-xs">Edit</button>
                <button @click="deleteProfile(profile.id)" class="btn-secondary px-3 py-1.5 text-xs text-red-400">Delete</button>
              </div>
            </div>
          </div>
        </template>
      </section>
    </div>

    <!-- ── Connect Shopify modal ─────────────────────────────────────────── -->
    <div v-if="showConnectModal === 'shopify'" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
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

    <!-- ── Connect Reverb modal ──────────────────────────────────────────── -->
    <div v-if="showConnectModal === 'reverb'" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div class="card w-full max-w-md p-6">
        <h2 class="text-base font-semibold text-white mb-4">Connect Reverb Account</h2>

        <p class="text-sm text-gray-400 mb-4">
          Reverb uses a Personal Access Token for API access. You can generate one in your
          <a href="https://reverb.com/my/account/apps" target="_blank" rel="noopener" class="text-brand-400 hover:underline">
            Reverb account settings → Apps & Integrations
          </a>.
        </p>

        <div class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Display name</label>
            <input
              v-model="reverbDisplayName"
              type="text"
              placeholder="My Reverb Store"
              class="w-full rounded-lg bg-gray-800 border border-gray-700 focus:border-brand-500 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Personal Access Token</label>
            <input
              v-model="reverbToken"
              type="password"
              placeholder="••••••••••••••••"
              class="w-full rounded-lg bg-gray-800 border border-gray-700 focus:border-brand-500 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none font-mono"
              @keydown.enter="connectReverb"
            />
          </div>
          <p v-if="reverbError" class="text-xs text-red-400">{{ reverbError }}</p>
        </div>

        <div class="mt-6 flex gap-3 justify-end">
          <button @click="closeConnectModal" class="btn-secondary px-4 py-2 text-sm">Cancel</button>
          <button @click="connectReverb" :disabled="connecting" class="btn-primary px-4 py-2 text-sm">
            {{ connecting ? 'Saving…' : 'Connect' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── Pricing Profile form modal ────────────────────────────────────── -->
    <div v-if="showProfileForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div class="card w-full max-w-sm p-6">
        <h2 class="text-base font-semibold text-white mb-4">
          {{ editingProfile ? 'Edit Pricing Profile' : 'New Pricing Profile' }}
        </h2>

        <div class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Profile name</label>
            <input
              v-model="profileForm.name"
              type="text"
              placeholder="e.g. eBay markup 5%"
              class="w-full rounded-lg bg-gray-800 border border-gray-700 focus:border-brand-500 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Adjustment (%)</label>
            <div class="flex items-center rounded-lg bg-gray-800 border border-gray-700 focus-within:border-brand-500 overflow-hidden">
              <input
                v-model="profileForm.adjustmentPercent"
                type="number"
                step="0.01"
                placeholder="0"
                class="flex-1 bg-transparent px-3 py-2 text-sm text-white placeholder-gray-600 outline-none"
              />
              <span class="pr-3 text-sm text-gray-500 select-none">%</span>
            </div>
            <p class="mt-1 text-xs text-gray-600">
              Positive = markup, negative = markdown. Final price = product price × (1 + %/100).
            </p>
          </div>
          <div v-if="editingProfile" class="flex items-center gap-2">
            <input id="profile-active" type="checkbox" v-model="profileForm.active" class="rounded" />
            <label for="profile-active" class="text-sm text-gray-300">Active</label>
          </div>
          <p v-if="profileError" class="text-xs text-red-400">{{ profileError }}</p>
        </div>

        <div class="mt-6 flex gap-3 justify-end">
          <button @click="closeProfileForm" class="btn-secondary px-4 py-2 text-sm">Cancel</button>
          <button @click="saveProfile" :disabled="savingProfile" class="btn-primary px-4 py-2 text-sm">
            {{ savingProfile ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── Excluded Tags editor modal ───────────────────────────────────── -->
    <div v-if="editingTagsAccount" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div class="card w-full max-w-md p-6">
        <h2 class="text-base font-semibold text-white mb-1">Excluded Tags</h2>
        <p class="text-xs text-gray-500 mb-4">
          Products tagged with any of these Shopify tags will be imported into Gearline
          but will <strong class="text-gray-300">not</strong> appear in the marketplace
          review queue. Useful for in-store-only inventory, consignment items, or anything
          you never intend to list on Reverb or eBay.
        </p>

        <!-- Current tags as removable chips -->
        <div class="flex flex-wrap gap-2 mb-3 min-h-[2rem]">
          <span
            v-for="tag in tagEditorTags"
            :key="tag"
            class="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs bg-gray-700 text-gray-200"
          >
            {{ tag }}
            <button @click="removeTag(tag)" class="text-gray-400 hover:text-red-400 leading-none">✕</button>
          </span>
          <span v-if="tagEditorTags.length === 0" class="text-xs text-gray-600 italic self-center">No tags configured</span>
        </div>

        <!-- Add a tag -->
        <div class="flex gap-2">
          <input
            v-model="tagInput"
            type="text"
            placeholder="e.g. no-marketplace"
            class="flex-1 rounded-lg bg-gray-800 border border-gray-700 focus:border-brand-500 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none"
            @keydown.enter.prevent="addTag"
            @keydown.comma.prevent="addTag"
          />
          <button @click="addTag" class="btn-secondary px-3 py-2 text-sm">Add</button>
        </div>
        <p class="mt-1 text-xs text-gray-600">Press Enter or comma to add. Matching is case-insensitive.</p>

        <div class="mt-6 flex gap-3 justify-end">
          <button @click="editingTagsAccount = null" class="btn-secondary px-4 py-2 text-sm">Cancel</button>
          <button @click="saveTags" :disabled="savingTags" class="btn-primary px-4 py-2 text-sm">
            {{ savingTags ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── Description Suffix editor modal ──────────────────────────────── -->
    <div v-if="editingSuffixAccount" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div class="card w-full max-w-md p-6">
        <h2 class="text-base font-semibold text-white mb-1">Description Suffix</h2>
        <p class="text-xs text-gray-500 mb-4">
          This text is appended to <em>every</em> listing description for
          <strong class="text-gray-300">{{ editingSuffixAccount.displayName }}</strong>,
          separated by a blank line. Leave empty to remove the suffix.
        </p>

        <textarea
          v-model="suffixEditorText"
          rows="4"
          placeholder="e.g. Contact us for international shipping quotes."
          class="w-full rounded-lg bg-gray-800 border border-gray-700 focus:border-brand-500 px-3 py-2 text-sm text-white placeholder-gray-600 outline-none resize-y"
        ></textarea>
        <p class="mt-1 text-xs text-gray-600">{{ suffixEditorText.length }} characters</p>

        <div class="mt-6 flex gap-3 justify-end">
          <button @click="editingSuffixAccount = null" class="btn-secondary px-4 py-2 text-sm">Cancel</button>
          <button @click="saveSuffix" :disabled="savingSuffix" class="btn-primary px-4 py-2 text-sm">
            {{ savingSuffix ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── Assign Pricing Profile modal ──────────────────────────────────── -->
    <div v-if="assigningAccount" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div class="card w-full max-w-sm p-6">
        <h2 class="text-base font-semibold text-white mb-1">Assign Pricing Profile</h2>
        <p class="text-xs text-gray-500 mb-4">{{ assigningAccount.displayName }}</p>

        <div class="space-y-2">
          <div
            v-for="profile in activeProfiles"
            :key="profile.id"
            @click="assignProfile(profile.id)"
            class="flex items-center justify-between rounded-lg border border-gray-700 px-4 py-3 cursor-pointer hover:border-brand-500 transition-colors"
            :class="assigningAccount.pricingProfileId === profile.id ? 'border-brand-500 bg-brand-900/20' : ''"
          >
            <div>
              <p class="text-sm text-white font-medium">{{ profile.name }}</p>
              <p class="text-xs text-gray-400">{{ formatAdjustment(profile.adjustmentPercent) }}</p>
            </div>
            <span v-if="assigningAccount.pricingProfileId === profile.id" class="text-brand-400 text-xs">Current</span>
          </div>
          <p v-if="activeProfiles.length === 0" class="text-xs text-gray-500 text-center py-4">
            No active pricing profiles. Create one in the section below.
          </p>
        </div>

        <div class="mt-6 flex justify-end">
          <button @click="assigningAccount = null" class="btn-secondary px-4 py-2 text-sm">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/lib/api'

const route = useRoute()

// ── Accounts ────────────────────────────────────────────────────────────────
const accounts = ref([])
const loading = ref(true)
const checking = ref({})
const syncing = ref({})
const showConnectModal = ref(null) // 'shopify' | 'reverb' | null

// Shopify fields
const shopDomain = ref('')
const domainError = ref('')

// Reverb fields
const reverbDisplayName = ref('')
const reverbToken = ref('')
const reverbError = ref('')

const connecting = ref(false)

// Surface results from OAuth redirects
const shopifyConnected = ref(route.query.shopify_connected || null)
const ebayConnected = ref(route.query.ebay_connected || null)
const connectionError = ref(route.query.error || null)

// ── Pricing Profiles ─────────────────────────────────────────────────────────
const profiles = ref([])
const profilesLoading = ref(true)
const showProfileForm = ref(false)
const editingProfile = ref(null) // profile being edited, or null for new
const savingProfile = ref(false)
const profileError = ref('')
const profileForm = ref({ name: '', adjustmentPercent: 0, active: true })

// Assign profile
const assigningAccount = ref(null)

// Excluded tags editor
const editingTagsAccount = ref(null)
const tagEditorTags = ref([])
const tagInput = ref('')
const savingTags = ref(false)

// Description suffix editor
const editingSuffixAccount = ref(null)
const suffixEditorText = ref('')
const savingSuffix = ref(false)

const activeProfiles = computed(() => profiles.value.filter(p => p.active))

// ── Load ─────────────────────────────────────────────────────────────────────
async function load() {
  loading.value = true
  try {
    const res = await api.get('/marketplace/accounts')
    accounts.value = res.data
  } finally { loading.value = false }
}

async function loadProfiles() {
  profilesLoading.value = true
  try {
    const res = await api.get('/pricing-profiles')
    profiles.value = res.data
  } finally { profilesLoading.value = false }
}

// ── Account actions ───────────────────────────────────────────────────────────
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

async function syncProducts(account) {
  syncing.value[account.id] = true
  try {
    await api.post(`/marketplace/accounts/${account.id}/sync-products`)
    // Sync runs in the background — poll for new products by reloading after a short delay
    setTimeout(() => load(), 3000)
  } catch (e) {
    console.error('Product sync failed:', e)
  } finally {
    // Keep the button disabled for a few seconds so the user knows it fired
    setTimeout(() => { syncing.value[account.id] = false }, 5000)
  }
}

function connectShopify() {
  domainError.value = ''
  const raw = shopDomain.value.trim()
  if (!raw) {
    domainError.value = 'Please enter your store name.'
    return
  }
  const domain = raw.endsWith('.myshopify.com') ? raw : raw + '.myshopify.com'
  const domainPattern = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/
  if (!domainPattern.test(domain)) {
    domainError.value = 'Invalid store name. Use letters, numbers, and hyphens only.'
    return
  }
  connecting.value = true
  const installUrl = `${import.meta.env.VITE_API_BASE_URL || ''}/api/v1/marketplace/shopify/oauth/install?shop=${encodeURIComponent(domain)}`
  window.location.href = installUrl
}

function connectEbay() {
  const installUrl = `${import.meta.env.VITE_API_BASE_URL || ''}/api/v1/marketplace/ebay/oauth/install`
  window.location.href = installUrl
}

async function connectReverb() {
  reverbError.value = ''
  const name = reverbDisplayName.value.trim()
  const token = reverbToken.value.trim()
  if (!name) { reverbError.value = 'Please enter a display name.'; return }
  if (!token) { reverbError.value = 'Please enter your Personal Access Token.'; return }
  connecting.value = true
  try {
    await api.post('/marketplace/accounts', {
      marketplaceType: 'REVERB',
      displayName: name,
      credentials: { access_token: token }
    })
    closeConnectModal()
    load()
  } catch (e) {
    reverbError.value = e.response?.data?.message || 'Failed to save account. Please try again.'
  } finally {
    connecting.value = false
  }
}

function closeConnectModal() {
  showConnectModal.value = null
  shopDomain.value = ''
  domainError.value = ''
  reverbDisplayName.value = ''
  reverbToken.value = ''
  reverbError.value = ''
  connecting.value = false
}

// ── Pricing profile actions ───────────────────────────────────────────────────
function editProfile(profile) {
  editingProfile.value = profile
  profileForm.value = { name: profile.name, adjustmentPercent: profile.adjustmentPercent, active: profile.active }
  showProfileForm.value = true
}

function closeProfileForm() {
  showProfileForm.value = false
  editingProfile.value = null
  profileForm.value = { name: '', adjustmentPercent: 0, active: true }
  profileError.value = ''
}

async function saveProfile() {
  profileError.value = ''
  const { name, adjustmentPercent, active } = profileForm.value
  if (!name.trim()) { profileError.value = 'Name is required.'; return }
  savingProfile.value = true
  try {
    if (editingProfile.value) {
      await api.put(`/pricing-profiles/${editingProfile.value.id}`, { name, adjustmentPercent, active })
    } else {
      await api.post('/pricing-profiles', { name, adjustmentPercent })
    }
    closeProfileForm()
    loadProfiles()
  } catch (e) {
    profileError.value = e.response?.data?.message || 'Failed to save profile.'
  } finally {
    savingProfile.value = false
  }
}

async function deleteProfile(id) {
  if (!confirm('Delete this pricing profile? Any accounts using it will no longer have a pricing adjustment applied.')) return
  await api.delete(`/pricing-profiles/${id}`)
  loadProfiles()
}

function openAssignProfile(account) {
  assigningAccount.value = account
}

async function assignProfile(profileId) {
  await api.patch(`/marketplace/accounts/${assigningAccount.value.id}/pricing-profile`, { pricingProfileId: profileId })
  assigningAccount.value = null
  load()
}

async function clearProfile(account) {
  await api.patch(`/marketplace/accounts/${account.id}/pricing-profile`, { pricingProfileId: null })
  load()
}

// ── Excluded tags ─────────────────────────────────────────────────────────────
function openTagEditor(account) {
  editingTagsAccount.value = account
  tagEditorTags.value = [...(account.excludedTags || [])]
  tagInput.value = ''
}

function addTag() {
  const tag = tagInput.value.trim().toLowerCase().replace(/,/g, '')
  if (tag && !tagEditorTags.value.includes(tag)) {
    tagEditorTags.value.push(tag)
  }
  tagInput.value = ''
}

function removeTag(tag) {
  tagEditorTags.value = tagEditorTags.value.filter(t => t !== tag)
}

async function saveTags() {
  savingTags.value = true
  try {
    await api.patch(`/marketplace/accounts/${editingTagsAccount.value.id}/settings`, {
      excludedTags: tagEditorTags.value
    })
    editingTagsAccount.value = null
    load()
  } finally {
    savingTags.value = false
  }
}

// ── Description suffix ────────────────────────────────────────────────────────
function openSuffixEditor(account) {
  editingSuffixAccount.value = account
  suffixEditorText.value = account.descriptionSuffix || ''
}

async function saveSuffix() {
  savingSuffix.value = true
  try {
    await api.patch(`/marketplace/accounts/${editingSuffixAccount.value.id}/settings`, {
      descriptionSuffix: suffixEditorText.value
    })
    editingSuffixAccount.value = null
    load()
  } finally {
    savingSuffix.value = false
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function connectionBadge(s) {
  return { CONNECTED: 'badge-green', DISCONNECTED: 'badge-gray', TOKEN_EXPIRED: 'badge-yellow', ERROR: 'badge-red', PENDING_OAUTH: 'badge-yellow' }[s] || 'badge-gray'
}

function formatDate(d) { return d ? new Date(d).toLocaleString() : '—' }

function formatAdjustment(pct) {
  const n = Number(pct)
  if (n === 0) return 'No adjustment (list at product price)'
  return n > 0 ? `+${n}% markup` : `${n}% markdown`
}

onMounted(() => {
  load()
  loadProfiles()
})
</script>
