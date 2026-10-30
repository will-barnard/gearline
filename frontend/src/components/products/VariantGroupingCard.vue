<template>
  <div v-if="visible" class="card">
    <div class="mb-2 flex items-center justify-between">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500">List variants together</h2>
      <span v-if="data?.grouping" class="badge-blue">{{ data.groups.length }} listing{{ data.groups.length === 1 ? '' : 's' }}</span>
    </div>

    <!-- This row is a member: point at the lead -->
    <div v-if="isMember" class="mb-3 rounded-lg border border-blue-800/60 bg-blue-950/30 px-3 py-2 text-xs text-blue-300">
      This variant isn't listed on its own — it's sold through the grouped listing for
      <router-link :to="`/products/${product.variantGroupLeadId}`" class="font-medium underline hover:text-blue-200">
        {{ leadTitle || 'its group' }}
      </router-link>.
    </div>

    <p class="mb-3 text-xs text-gray-500">
      Collapse an option (like Color) to publish one marketplace listing per remaining combination.
      Buyers order the listing and message their choice; the Shopify order gets a note to confirm it.
    </p>

    <div v-if="loading" class="py-4 text-center text-xs text-gray-500">Loading variants…</div>
    <p v-else-if="error" class="text-xs text-red-400">{{ error }}</p>

    <template v-else-if="data">
      <p v-if="data.unknownOptionCount > 0" class="mb-3 text-xs text-amber-400">
        {{ data.unknownOptionCount }} variant{{ data.unknownOptionCount === 1 ? '' : 's' }} have no option data yet and will
        list on their own. Re-sync the product from Shopify, or save any change to it there.
      </p>

      <!-- Options to collapse -->
      <div class="mb-3 flex flex-wrap gap-4">
        <label
          v-for="opt in data.options"
          :key="opt.name"
          class="flex cursor-pointer items-center gap-2 text-xs text-gray-300"
        >
          <input
            type="checkbox"
            :checked="draft.collapsed.includes(opt.name)"
            :disabled="saving"
            @change="toggleOption(opt.name)"
            class="rounded border-gray-600 bg-gray-800"
          />
          Collapse {{ opt.name }}
          <span class="text-gray-600">({{ opt.values.length }})</span>
        </label>
      </div>

      <template v-if="draft.collapsed.length > 0">
        <label class="mb-1 block text-xs text-gray-500">Note to buyers (added to each listing's description)</label>
        <input
          v-model="draft.buyerNote"
          :placeholder="defaultNote"
          :disabled="saving"
          class="input mb-1 w-full text-xs"
          @input="schedulePreview"
        />
        <p class="mb-4 text-[11px] text-gray-600">
          <code>{options}</code> becomes the option name. The list of choices is added above the note automatically.
        </p>

        <div v-if="previewing" class="mb-2 text-xs text-gray-500">Updating preview…</div>

        <!-- Groups -->
        <div class="space-y-3">
          <div
            v-for="g in preview?.groups || []"
            :key="g.key"
            class="rounded-lg border border-gray-800 bg-gray-950/50 p-3"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="truncate text-sm font-medium text-gray-200">{{ g.title }}</div>
                <div class="mt-0.5 text-xs text-gray-500">
                  {{ g.members.length }} variant{{ g.members.length === 1 ? '' : 's' }} ·
                  qty {{ g.quantity }} · ${{ g.price }} · {{ g.imageUrls.length }} photo{{ g.imageUrls.length === 1 ? '' : 's' }}
                </div>
              </div>
              <span class="badge-gray shrink-0">{{ g.label }}</span>
            </div>

            <p v-if="g.priceMismatch" class="mt-2 text-xs text-amber-400">
              These variants aren't all the same price — the listing uses the lead's ${{ g.price }}.
            </p>

            <!-- Photo strip, lead first -->
            <div v-if="g.imageUrls.length" class="mt-2 flex gap-1.5 overflow-x-auto">
              <img
                v-for="(url, i) in g.imageUrls.slice(0, 8)"
                :key="url"
                :src="url"
                :class="['h-12 w-12 shrink-0 rounded object-cover', i === 0 ? 'ring-2 ring-brand-500' : 'opacity-80']"
                loading="lazy"
              />
              <span v-if="g.imageUrls.length > 8" class="self-center px-1 text-xs text-gray-500">+{{ g.imageUrls.length - 8 }}</span>
            </div>

            <!-- Lead picker -->
            <div class="mt-2 text-[11px] uppercase tracking-wider text-gray-600">Lead variant (its photo goes first)</div>
            <div class="mt-1 flex flex-wrap gap-1.5">
              <button
                v-for="m in g.members"
                :key="m.productId"
                type="button"
                :disabled="saving"
                @click="chooseLead(g, m)"
                :class="[
                  'flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition-colors',
                  m.isLead
                    ? 'border-brand-500 bg-brand-500/10 text-blue-300'
                    : 'border-gray-700 text-gray-400 hover:border-gray-500',
                ]"
                :title="m.sku"
              >
                <img v-if="m.imageUrl" :src="m.imageUrl" class="h-4 w-4 rounded-sm object-cover" />
                {{ collapsedLabel(m) }}
                <span v-if="m.quantity > 0" class="text-gray-600">· {{ m.quantity }}</span>
              </button>
            </div>
          </div>
        </div>
      </template>

      <div class="mt-4 flex items-center gap-2">
        <button
          class="btn-primary px-3 py-1.5 text-xs"
          :disabled="saving || !dirty || (draft.collapsed.length === 0 && !data.grouping)"
          @click="save"
        >{{ saving ? 'Saving…' : draft.collapsed.length === 0 && data.grouping ? 'Remove grouping' : 'Save grouping' }}</button>
        <button
          v-if="dirty && !saving"
          class="btn-secondary px-3 py-1.5 text-xs"
          @click="reset"
        >Discard changes</button>
        <span v-if="savedMessage" class="text-xs text-green-400">{{ savedMessage }}</span>
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * Variant grouping — collapse options (Color) so a Shopify product with many
 * variants lists once per remaining combination (Size × Cut). Backed by
 * services/variant-groups.ts; the config belongs to the Shopify product, so
 * it can be edited from any of its variants.
 */
import { ref, computed, watch, onMounted } from 'vue'
import api from '@/lib/api'

const props = defineProps({
  product: { type: Object, required: true },
})
const emit = defineEmits(['changed'])

const defaultNote = 'After you order, send us a message with the {options} you would like.'

const data = ref(null)
const preview = ref(null)
const loading = ref(false)
const previewing = ref(false)
const saving = ref(false)
const error = ref(null)
const savedMessage = ref('')
const draft = ref({ collapsed: [], leads: {}, buyerNote: '' })

const isMember = computed(
  () => props.product.variantGroupLeadId && props.product.variantGroupLeadId !== props.product.id,
)
// Only meaningful for a Shopify product with more than one variant.
const visible = computed(() => props.product.shopifyProductId && (loading.value || (data.value?.variantCount ?? 0) > 1))

const leadTitle = computed(() => {
  for (const g of data.value?.groups || []) {
    if (g.leadProductId === props.product.variantGroupLeadId) return g.title
  }
  return null
})

function snapshot(d) {
  const leads = {}
  for (const g of d.groups || []) if (g.leadVariantId) leads[g.key] = g.leadVariantId
  return {
    collapsed: [...(d.grouping?.collapsedOptions || [])],
    leads,
    buyerNote: d.grouping?.buyerNote || '',
  }
}

const savedSnapshot = ref(null)
const dirty = computed(() => JSON.stringify(normalised(draft.value)) !== JSON.stringify(normalised(savedSnapshot.value)))

function normalised(d) {
  if (!d) return null
  return {
    collapsed: [...d.collapsed].sort(),
    leads: d.collapsed.length ? Object.values(d.leads).sort() : [],
    buyerNote: d.collapsed.length ? (d.buyerNote || '').trim() : '',
  }
}

function payload() {
  return {
    collapsedOptions: draft.value.collapsed,
    leadVariantIds: Object.values(draft.value.leads),
    buyerNote: draft.value.buyerNote || null,
  }
}

async function load() {
  if (!props.product.shopifyProductId) return
  loading.value = true
  error.value = null
  try {
    const res = await api.get(`/products/${props.product.id}/variant-grouping`)
    data.value = res.data
    preview.value = res.data
    draft.value = snapshot(res.data)
    savedSnapshot.value = snapshot(res.data)
  } catch (e) {
    error.value = e.response?.data?.detail || 'Could not load variants.'
  } finally {
    loading.value = false
  }
}

let previewTimer = null
function schedulePreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(runPreview, 300)
}

async function runPreview() {
  if (draft.value.collapsed.length === 0) {
    preview.value = { ...data.value, groups: [] }
    return
  }
  previewing.value = true
  try {
    const res = await api.post(`/products/${props.product.id}/variant-grouping/preview`, payload())
    preview.value = res.data
    // Keep lead choices only for groups that still exist; fill in the defaults.
    const leads = {}
    for (const g of res.data.groups) leads[g.key] = draft.value.leads[g.key] ?? g.leadVariantId
    draft.value.leads = leads
  } catch (e) {
    error.value = e.response?.data?.detail || 'Preview failed.'
  } finally {
    previewing.value = false
  }
}

function toggleOption(name) {
  const set = new Set(draft.value.collapsed)
  if (set.has(name)) set.delete(name)
  else set.add(name)
  draft.value.collapsed = data.value.options.map(o => o.name).filter(n => set.has(n))
  draft.value.leads = {}
  savedMessage.value = ''
  schedulePreview()
}

function chooseLead(group, member) {
  draft.value.leads = { ...draft.value.leads, [group.key]: member.variantId }
  savedMessage.value = ''
  schedulePreview()
}

function collapsedLabel(member) {
  const wanted = draft.value.collapsed.map(n => n.toLowerCase())
  const values = (member.options || []).filter(o => wanted.includes(o.name.toLowerCase())).map(o => o.value)
  return values.join(' / ') || member.sku
}

function reset() {
  draft.value = JSON.parse(JSON.stringify(savedSnapshot.value))
  preview.value = data.value
  error.value = null
}

async function save() {
  saving.value = true
  error.value = null
  try {
    const res = await api.put(`/products/${props.product.id}/variant-grouping`, payload())
    data.value = res.data
    preview.value = res.data
    draft.value = snapshot(res.data)
    savedSnapshot.value = snapshot(res.data)
    savedMessage.value = res.data.grouping ? 'Saved — listings updated.' : 'Grouping removed.'
    emit('changed')
  } catch (e) {
    error.value = e.response?.data?.detail || 'Could not save the grouping.'
  } finally {
    saving.value = false
  }
}

watch(() => props.product.id, load)
onMounted(load)
</script>
