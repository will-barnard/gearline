<template>
  <div v-if="product.shopifyProductId || data?.available?.length" id="listing-photos" class="card">
    <div class="mb-2 flex items-center justify-between gap-3">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">
        {{ data?.isGroupLead ? 'Group listing photos' : 'Listing photos' }}
      </h2>
      <span v-if="data && !data.listedThroughLeadId" :class="isCustom ? 'badge-blue' : 'badge-gray'">
        {{ isCustom ? 'Picked by hand' : 'Automatic' }}
      </span>
    </div>

    <div v-if="loading" class="py-4 text-center text-xs text-gray-500">Loading photos…</div>
    <p v-else-if="loadError" class="text-xs text-red-400">{{ loadError }}</p>

    <!-- A group member has no listing of its own -->
    <div
      v-else-if="data?.listedThroughLeadId"
      class="rounded-lg border border-blue-800/60 bg-blue-950/30 px-3 py-2 text-xs text-blue-300"
    >
      This variant is sold through a grouped listing, so its photos are picked on the group's
      <router-link :to="`/products/${data.listedThroughLeadId}#listing-photos`" class="font-medium underline hover:text-blue-200">lead variant</router-link>.
    </div>

    <template v-else-if="data">
      <p class="mb-3 text-xs text-gray-500">
        <template v-if="data.isGroupLead">Every marketplace gets these photos for the whole group's listing.</template>
        <template v-else>Every marketplace gets these photos for this variant.</template>
        Automatic means this variant's own Shopify photo plus the photos right after it in Shopify's order.
        Pick photos below to choose them yourself.
      </p>

      <p v-if="data.available.length === 0" class="text-xs text-amber-400">
        This product has no photos in Shopify yet.
      </p>

      <template v-else>
        <!-- What the listings get, in order -->
        <div class="mb-1 flex items-baseline justify-between">
          <span class="text-[11px] uppercase tracking-wider text-gray-600">
            On the listings · {{ draft.length }} photo{{ draft.length === 1 ? '' : 's' }}
          </span>
          <span class="text-[11px] text-gray-600">Drag to reorder · first is the cover</span>
        </div>

        <div class="mb-1 flex min-h-[4.5rem] flex-wrap gap-2 rounded-lg border border-gray-800 bg-gray-950/50 p-2">
          <div
            v-for="(url, i) in draft"
            :key="url"
            draggable="true"
            @dragstart="onDragStart(i, $event)"
            @dragover.prevent="onDragOver(i)"
            @drop.prevent="onDrop"
            @dragend="dragIndex = null; overIndex = null"
            :class="[
              'group relative h-16 w-16 shrink-0 cursor-grab overflow-hidden rounded',
              i === 0 ? 'ring-2 ring-brand-500' : 'ring-1 ring-gray-700',
              overIndex === i && dragIndex !== null && dragIndex !== i ? 'outline outline-2 outline-blue-400' : '',
              dragIndex === i ? 'opacity-40' : '',
            ]"
          >
            <img :src="url" class="h-full w-full object-cover" loading="lazy" draggable="false" />
            <span class="absolute left-0.5 top-0.5 rounded bg-black/70 px-1 text-[10px] text-gray-200">{{ i + 1 }}</span>
            <div class="absolute inset-x-0 bottom-0 hidden justify-between bg-black/70 group-hover:flex">
              <button type="button" class="px-1 text-xs text-gray-200 hover:text-white disabled:opacity-30" :disabled="saving || i === 0" @click="move(i, -1)" title="Move left">‹</button>
              <button type="button" class="px-1 text-xs text-red-300 hover:text-red-200" :disabled="saving" @click="remove(i)" title="Remove from listings">✕</button>
              <button type="button" class="px-1 text-xs text-gray-200 hover:text-white disabled:opacity-30" :disabled="saving || i === draft.length - 1" @click="move(i, 1)" title="Move right">›</button>
            </div>
          </div>
          <p v-if="draft.length === 0" class="self-center px-1 text-xs text-gray-500">
            No photos picked — saving goes back to automatic.
          </p>
        </div>

        <p v-if="draft.length > 12" class="mb-1 text-xs text-amber-400">
          eBay only takes the first 12 photos.
        </p>
        <p v-for="o in data.listingOverrides" :key="o.listingId" class="mb-1 text-xs text-amber-400">
          The {{ marketplaceName(o.marketplaceType) }} listing has its own photo override, which wins over this.
        </p>

        <!-- Everything on the Shopify product -->
        <div class="mb-1 mt-3 text-[11px] uppercase tracking-wider text-gray-600">
          All photos on the Shopify product · click to add or remove
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="url in data.available"
            :key="url"
            type="button"
            :disabled="saving || (!draft.includes(url) && draft.length >= data.maxPhotos)"
            @click="toggle(url)"
            :class="[
              'relative h-14 w-14 shrink-0 overflow-hidden rounded transition',
              draft.includes(url) ? 'ring-2 ring-brand-500' : 'opacity-50 ring-1 ring-gray-700 hover:opacity-90',
            ]"
            :title="photoLabel(url)"
          >
            <img :src="url" class="h-full w-full object-cover" loading="lazy" />
            <span v-if="draft.includes(url)" class="absolute right-0.5 top-0.5 rounded bg-brand-500 px-1 text-[10px] text-white">
              {{ draft.indexOf(url) + 1 }}
            </span>
            <span
              v-if="tag(url)"
              :class="[
                'absolute inset-x-0 bottom-0 truncate px-0.5 text-center text-[9px] leading-tight',
                tag(url) === 'This variant' ? 'bg-brand-500/80 text-white' : 'bg-black/70 text-gray-300',
              ]"
            >{{ tag(url) }}</span>
          </button>
        </div>
      </template>

      <!-- Actions -->
      <div class="mt-4 flex flex-wrap items-center gap-2">
        <button class="btn-primary px-3 py-1.5 text-xs" :disabled="saving || !dirty" @click="save(draft)">
          {{ saving ? 'Saving…' : 'Save photos' }}
        </button>
        <button v-if="dirty && !saving" class="btn-secondary px-3 py-1.5 text-xs" @click="discard">Discard changes</button>
        <button
          v-if="isCustom && !dirty && !saving"
          class="btn-secondary px-3 py-1.5 text-xs"
          @click="save(null)"
          title="Forget the picked photos and use the automatic ones again"
        >Reset to automatic</button>
        <button
          v-if="!dirty && !saving"
          class="btn-secondary px-3 py-1.5 text-xs"
          :disabled="pushing"
          @click="push"
          title="Re-send these photos to every live listing — use this for listings published before a photo change"
        >{{ pushing ? 'Queuing…' : 'Push to live listings' }}</button>
        <span v-if="message" :class="['text-xs', messageIsError ? 'text-red-400' : 'text-green-400']">{{ message }}</span>
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * Which photos this variant's marketplace listings carry (backend:
 * services/listing-photos.ts). Automatic by default; picking photos here saves
 * an ordered selection on the variant that every marketplace uses, and queues
 * an update that replaces the photos on its live listings. On a variant-group
 * lead it picks the photos for the whole group's listing.
 */
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/lib/api'

const props = defineProps({
  product: { type: Object, required: true },
})
const route = useRoute()

const data = ref(null)
const draft = ref([])
const loading = ref(false)
const loadError = ref(null)
const saving = ref(false)
const pushing = ref(false)
const message = ref('')
const messageIsError = ref(false)

const isCustom = computed(() => data.value?.mode === 'custom')
const dirty = computed(() => !!data.value && JSON.stringify(draft.value) !== JSON.stringify(data.value.effective))

const MARKETPLACE_NAMES = { EBAY: 'eBay', REVERB: 'Reverb', GEAR_EXCHANGE: 'Gear Exchange' }
const marketplaceName = (t) => MARKETPLACE_NAMES[t] || t

function tag(url) {
  if (!data.value) return null
  if (url === data.value.variantImageUrl) return 'This variant'
  if (data.value.otherVariantImageUrls.includes(url)) return 'Other variant'
  return null
}

function photoLabel(url) {
  const t = tag(url)
  const base = draft.value.includes(url) ? 'On the listings — click to remove' : 'Click to add'
  return t ? `${t}'s Shopify photo · ${base}` : base
}

function apply(res) {
  data.value = res
  draft.value = [...res.effective]
}

function say(text, isError = false) {
  message.value = text
  messageIsError.value = isError
}

async function load() {
  if (!props.product?.id) return
  loading.value = true
  loadError.value = null
  try {
    const res = await api.get(`/products/${props.product.id}/listing-photos`)
    apply(res.data)
    // Arrived from a "choose photos" link: the page scrolls in a container,
    // not the window, so the router cannot do this itself.
    if (route.hash === '#listing-photos') {
      await nextTick()
      document.getElementById('listing-photos')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  } catch (e) {
    loadError.value = e.response?.data?.detail || 'Could not load photos.'
  } finally {
    loading.value = false
  }
}

function toggle(url) {
  say('')
  const i = draft.value.indexOf(url)
  if (i >= 0) draft.value = draft.value.filter((u) => u !== url)
  else if (draft.value.length < data.value.maxPhotos) draft.value = [...draft.value, url]
}

function remove(i) {
  say('')
  draft.value = draft.value.filter((_, j) => j !== i)
}

function move(i, delta) {
  const j = i + delta
  if (j < 0 || j >= draft.value.length) return
  const next = [...draft.value]
  ;[next[i], next[j]] = [next[j], next[i]]
  draft.value = next
  say('')
}

// ── Drag to reorder ───────────────────────────────────────────────────────
const dragIndex = ref(null)
const overIndex = ref(null)

function onDragStart(i, e) {
  dragIndex.value = i
  e.dataTransfer.effectAllowed = 'move'
  // Firefox will not start a drag without data.
  e.dataTransfer.setData('text/plain', String(i))
}

function onDragOver(i) {
  overIndex.value = i
}

function onDrop() {
  const from = dragIndex.value
  const to = overIndex.value
  dragIndex.value = null
  overIndex.value = null
  if (from === null || to === null || from === to) return
  const next = [...draft.value]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  draft.value = next
  say('')
}

function discard() {
  draft.value = [...data.value.effective]
  say('')
}

function queuedText(n, verb) {
  if (n === 0) return `${verb} — no live listings to update.`
  return `${verb} — updating ${n} live listing${n === 1 ? '' : 's'}.`
}

async function save(urls) {
  saving.value = true
  say('')
  try {
    // Saving exactly the automatic photos is the same as automatic: don't pin them.
    const same = urls && JSON.stringify(urls) === JSON.stringify(data.value.automatic)
    const res = await api.put(`/products/${props.product.id}/listing-photos`, {
      imageUrls: urls && urls.length > 0 && !same ? urls : null,
    })
    apply(res.data)
    say(queuedText(res.data.queued, res.data.mode === 'custom' ? 'Saved' : 'Back to automatic'))
  } catch (e) {
    say(e.response?.data?.detail || 'Could not save the photos.', true)
  } finally {
    saving.value = false
  }
}

async function push() {
  pushing.value = true
  say('')
  try {
    const res = await api.post(`/products/${props.product.id}/listing-photos/push`)
    say(queuedText(res.data.queued, 'Queued'))
  } catch (e) {
    say(e.response?.data?.detail || 'Could not queue the update.', true)
  } finally {
    pushing.value = false
  }
}

watch(() => [props.product.id, props.product.variantGroupLeadId], load)
onMounted(load)
</script>
