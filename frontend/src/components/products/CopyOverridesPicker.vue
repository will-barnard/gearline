<template>
  <div ref="rootEl" class="relative inline-block">
    <button
      type="button"
      class="text-xs text-brand-400 hover:text-brand-300"
      @click="toggle"
    >⇅ Copy from another size ▾</button>

    <div
      v-if="open"
      class="absolute z-20 mt-1 w-72 max-h-64 overflow-auto rounded-lg border border-gray-700 bg-gray-900 text-xs shadow-xl"
    >
      <div v-if="loading" class="px-3 py-2 text-gray-500">Loading…</div>
      <template v-else-if="error">
        <p class="px-3 py-2 text-red-400">{{ error }}</p>
      </template>
      <template v-else>
        <button
          v-for="s in siblings"
          :key="s.id"
          type="button"
          class="block w-full border-b border-gray-800 px-3 py-2 text-left last:border-0 hover:bg-gray-800"
          @click="apply(s)"
        >
          <div class="text-gray-200">{{ s.productSku || s.productTitle || 'Untitled' }}</div>
          <div class="mt-0.5 truncate text-gray-600">{{ summarize(s.listingOverrides) }}</div>
        </button>
        <p v-if="!siblings.length" class="px-3 py-2 text-gray-600">
          No other size has marketplace overrides set yet.
        </p>
      </template>
    </div>
  </div>
</template>

<script setup>
/**
 * "Copy from another size" — pulls listing_overrides from a sibling listing
 * (another Shopify variant of the same parent product, on the same
 * marketplace account) into this one, so Will doesn't have to re-enter
 * Reverb's product type or eBay's category/policies for every size of the
 * same shirt.
 *
 * This component only fetches the candidate list and reports which one was
 * picked — applying the values (and deciding which fields to skip, like
 * price/title) is the parent's job, since it already owns the edit-overrides
 * form state.
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import api from '@/lib/api'

const props = defineProps({
  listingId: { type: String, required: true },
})
const emit = defineEmits(['apply'])

const rootEl = ref(null)
const open = ref(false)
const loading = ref(false)
const error = ref(null)
const siblings = ref([])
const loaded = ref(false)

async function toggle() {
  open.value = !open.value
  if (open.value && !loaded.value) {
    await fetchSiblings()
  }
}

async function fetchSiblings() {
  loading.value = true
  error.value = null
  try {
    const res = await api.get(`/listings/${props.listingId}/siblings`)
    siblings.value = res.data || []
    loaded.value = true
  } catch (e) {
    error.value = e.response?.data?.message || e.response?.data?.error || 'Could not load other sizes'
  } finally {
    loading.value = false
  }
}

const FIELD_LABELS = {
  reverb_model: 'model',
  reverb_year: 'year',
  reverb_finish: 'finish',
  reverb_shipping_profile_name: 'shipping profile',
  category_id: 'Reverb product type',
  ebay_category_id: 'eBay category',
  condition_mapping: 'condition',
  ebay_fulfillment_policy_id: 'fulfillment policy',
  ebay_return_policy_id: 'return policy',
  ebay_payment_policy_id: 'payment policy',
  ebay_package_type: 'package type',
  ebay_item_specifics: 'item specifics',
  ebay_merchant_location_key: 'location',
  description: 'description',
  price: 'price',
  title: 'title',
}

/** Short human summary of what a sibling's overrides would bring over (price/title excluded — see parent). */
function summarize(overrides) {
  const keys = Object.keys(overrides || {}).filter((k) => k !== 'price' && k !== 'title')
  if (!keys.length) return 'Only price/title set — nothing to copy'
  return keys.map((k) => FIELD_LABELS[k] || k).join(', ')
}

function apply(sibling) {
  emit('apply', sibling)
  open.value = false
}

function onDocMousedown(e) {
  if (open.value && rootEl.value && !rootEl.value.contains(e.target)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', onDocMousedown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMousedown))
</script>
