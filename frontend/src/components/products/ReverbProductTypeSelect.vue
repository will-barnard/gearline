<template>
  <div ref="rootEl" class="relative">
    <input
      type="text"
      :class="inputClass"
      :value="displayText"
      :placeholder="placeholder"
      autocomplete="off"
      @focus="openDropdown"
      @input="onInput"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter.prevent="chooseHighlighted"
      @keydown.esc="closeDropdown"
    />
    <button
      v-if="modelValue && !open"
      type="button"
      tabindex="-1"
      class="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400"
      title="Clear product type"
      @mousedown.prevent="clearValue"
    >✕</button>

    <div
      v-if="open"
      class="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-gray-700 bg-gray-900 text-xs shadow-xl"
    >
      <div v-if="loading" class="px-3 py-2 text-gray-500">Loading…</div>
      <template v-else>
        <template v-for="(c, i) in visibleOptions" :key="c.uuid">
          <p v-if="i === 0 && recentCount > 0" class="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
            Recently used
          </p>
          <p v-if="i === recentCount && recentCount > 0" class="border-t border-gray-800 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
            All product types
          </p>
          <button
            type="button"
            class="block w-full truncate px-3 py-1.5 text-left"
            :class="i === highlightedIndex ? 'bg-gray-800 text-brand-400' : 'text-gray-300 hover:bg-gray-800'"
            @mousedown.prevent="choose(c)"
            @mouseenter="highlightedIndex = i"
          >{{ c.name }}</button>
        </template>
        <p v-if="!visibleOptions.length" class="px-3 py-2 text-gray-600">
          {{ query ? 'No matches' : 'No product types available' }}
        </p>
      </template>
    </div>
  </div>
</template>

<script setup>
/**
 * Searchable combobox for Reverb's "product type" (their name for category).
 * Reverb ships hundreds of these, so a plain <select> is painful to navigate —
 * this adds a text filter plus a per-account "recently used" shortlist
 * (persisted in localStorage, since it's a pure UI convenience with no need
 * to round-trip to the backend).
 *
 * Props:
 *  - modelValue: selected category uuid (or '')
 *  - accountId: Reverb marketplace account this list of categories belongs to
 *               (recents are scoped per-account, since product types differ by account)
 *  - categories: [{ uuid, name }, ...] — the full list for this account
 *  - loading: true while categories are still being fetched
 *  - placeholder: text shown when nothing is selected/typed (caller controls this,
 *               since the exact wording depends on account-mapping fallback state)
 *  - size: 'xs' (default, inline overrides editor) | 'sm' (publish modal)
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  accountId: { type: String, default: '' },
  categories: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  placeholder: { type: String, default: '— Select product type —' },
  size: { type: String, default: 'xs' },
})
const emit = defineEmits(['update:modelValue'])

const STORAGE_KEY = 'gearline:reverbRecentProductTypes'
const MAX_RECENTS = 5

function readRecentsMap() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeRecentsMap(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) — recents just won't persist
  }
}

function rememberRecent(uuid) {
  const map = readRecentsMap()
  const list = (map[props.accountId] || []).filter((id) => id !== uuid)
  list.unshift(uuid)
  map[props.accountId] = list.slice(0, MAX_RECENTS)
  writeRecentsMap(map)
  recents.value = map[props.accountId]
}

const recents = ref(readRecentsMap()[props.accountId] || [])
watch(() => props.accountId, (id) => {
  recents.value = readRecentsMap()[id] || []
})

const rootEl = ref(null)
const open = ref(false)
const query = ref('')
const highlightedIndex = ref(-1)

const selectedCategory = computed(() =>
  props.categories.find((c) => c.uuid === props.modelValue) || null
)

const displayText = computed(() => (open.value ? query.value : (selectedCategory.value?.name || '')))

const inputClass = computed(() => [
  'input w-full pr-6',
  props.size === 'sm' ? 'py-1.5 text-sm' : 'mt-1 py-1 text-xs',
].join(' '))

/** Full option list for the open dropdown: recents first (when not searching), then the rest. */
const visibleOptions = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (q) {
    return props.categories.filter((c) => c.name.toLowerCase().includes(q))
  }
  const recentCats = recents.value
    .map((uuid) => props.categories.find((c) => c.uuid === uuid))
    .filter(Boolean)
  const recentUuids = new Set(recentCats.map((c) => c.uuid))
  const rest = props.categories.filter((c) => !recentUuids.has(c.uuid))
  return [...recentCats, ...rest]
})

const recentCount = computed(() => (query.value.trim() ? 0 : Math.min(recents.value.length, visibleOptions.value.length)))

function openDropdown() {
  open.value = true
  query.value = ''
  highlightedIndex.value = -1
}

function closeDropdown() {
  open.value = false
  query.value = ''
  highlightedIndex.value = -1
}

function onInput(e) {
  query.value = e.target.value
  open.value = true
  highlightedIndex.value = visibleOptions.value.length ? 0 : -1
}

function move(delta) {
  if (!open.value) { openDropdown(); return }
  const n = visibleOptions.value.length
  if (!n) return
  if (highlightedIndex.value === -1) highlightedIndex.value = delta > 0 ? 0 : n - 1
  else highlightedIndex.value = (highlightedIndex.value + delta + n) % n
}

function chooseHighlighted() {
  const opt = visibleOptions.value[highlightedIndex.value]
  if (opt) choose(opt)
  else if (visibleOptions.value.length === 1) choose(visibleOptions.value[0])
}

function choose(c) {
  emit('update:modelValue', c.uuid)
  rememberRecent(c.uuid)
  closeDropdown()
}

function clearValue() {
  emit('update:modelValue', '')
  query.value = ''
}

function onDocMousedown(e) {
  if (open.value && rootEl.value && !rootEl.value.contains(e.target)) {
    closeDropdown()
  }
}
onMounted(() => document.addEventListener('mousedown', onDocMousedown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMousedown))
</script>
