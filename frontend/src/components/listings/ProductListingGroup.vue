<template>
  <!-- ── Collapsed: one row per PRODUCT, whatever it is listed on ─────────── -->
  <tr class="table-row">
    <td class="px-4 py-3">
      <div class="flex items-start gap-2">
        <button
          @click="expanded = !expanded"
          class="mt-0.5 text-gray-600 hover:text-gray-300 transition-colors shrink-0"
          :aria-expanded="expanded"
          :aria-label="expanded ? 'Hide channels' : 'Show channels'"
        >
          <span class="inline-block w-3 text-xs" :class="expanded ? 'rotate-90' : ''">&#9656;</span>
        </button>
        <div class="min-w-0">
          <router-link
            :to="`/products/${group.productId}`"
            class="text-sm text-white hover:text-brand-400 transition-colors font-medium"
          >{{ group.productTitle || group.productSku || group.productId }}</router-link>
          <p v-if="group.productSku" class="text-xs text-gray-500 font-mono mt-0.5">{{ group.productSku }}</p>
        </div>
      </div>
    </td>

    <!-- Channels: one chip per marketplace, coloured by that listing's status -->
    <td class="px-4 py-3">
      <div class="flex flex-wrap items-center gap-1.5">
        <span
          v-for="l in group.listings"
          :key="l.id"
          :class="chipClass(l.listingStatus)"
          :title="`${l.marketplaceType}: ${l.listingStatus}${l.lastError ? ' — ' + l.lastError : ''}`"
        >{{ l.marketplaceType }}</span>
      </div>
      <p v-if="summary" class="mt-1 text-xs text-gray-500">{{ summary }}</p>
    </td>

    <td class="px-4 py-3 text-right text-gray-200 text-xs">{{ formatPrice(group.productPrice) }}</td>
    <td class="px-4 py-3 text-right text-gray-200 text-xs">{{ group.productQuantity ?? '—' }}</td>

    <!-- Worst error across the product's channels, so a problem is visible collapsed -->
    <td class="px-4 py-3 max-w-xs">
      <span
        v-if="firstError"
        class="text-xs text-red-400 truncate block"
        :title="firstError.lastError"
      >{{ firstError.marketplaceType }}: {{ firstError.lastError }}</span>
    </td>

    <td class="px-4 py-3">
      <div class="flex gap-2 justify-end items-center">
        <span v-if="group.workingCount" class="text-xs text-gray-500 italic">Working…</span>
        <button
          v-else-if="group.readyCount > 0"
          @click="$emit('publish', group.readyListingIds)"
          class="rounded px-3 py-1 text-xs font-medium bg-brand-600 text-white hover:bg-brand-500 transition-colors"
        >
          Publish{{ group.readyCount > 1 ? ` ${group.readyCount}` : '' }}
        </button>
        <router-link
          :to="`/products/${group.productId}`"
          class="text-xs text-gray-400 hover:text-white transition-colors"
        >Configure</router-link>
      </div>
    </td>
  </tr>

  <!-- ── Expanded: the per-marketplace detail the collapsed row hides ─────── -->
  <tr v-if="expanded" class="bg-gray-900/40">
    <td colspan="6" class="px-4 pb-3 pt-1">
      <div class="ml-5 divide-y divide-gray-800/70 rounded-lg border border-gray-800">
        <div
          v-for="l in group.listings"
          :key="l.id"
          class="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2"
        >
          <span class="badge-blue shrink-0">{{ l.marketplaceType }}</span>
          <span :class="statusBadge(l.listingStatus)">{{ l.listingStatus }}</span>

          <span v-if="l.externalListingId" class="font-mono text-xs text-gray-500">{{ l.externalListingId }}</span>

          <span class="text-xs text-gray-500">
            {{ l.syncedPrice != null ? formatPrice(l.syncedPrice) : '—' }}
            &middot;
            {{ l.syncedQuantity ?? '—' }} in stock
          </span>

          <span class="text-xs text-gray-600">{{ formatDate(l.lastSyncAt) }}</span>

          <span
            v-if="l.lastError"
            class="text-xs text-red-400 truncate max-w-md"
            :title="l.lastError"
          >{{ l.lastError }}</span>

          <span class="ml-auto flex items-center gap-3 shrink-0">
            <span
              v-if="['PENDING','PUBLISHING'].includes(l.listingStatus)"
              class="text-xs text-gray-500 italic"
            >Working…</span>
            <template v-else>
              <button
                v-if="l.listingStatus === 'ACTIVE'"
                @click="$emit('delist', l.id)"
                class="text-xs text-red-400 hover:text-red-300 transition-colors"
              >Delist</button>
              <template v-else>
                <button
                  @click="$emit('publish', [l.id])"
                  class="text-xs text-brand-400 hover:text-brand-300 transition-colors"
                >{{ l.listingStatus === 'NEEDS_REVIEW' ? 'Publish' : 'Re-publish' }}</button>
                <button
                  @click="$emit('archive', l.id)"
                  class="text-xs text-gray-500 hover:text-red-400 transition-colors"
                  title="Remove from the queue without publishing"
                >Archive</button>
              </template>
            </template>
          </span>
        </div>
      </div>
    </td>
  </tr>
</template>

<script setup>
import { computed, ref } from 'vue'
import { summarise } from '@/lib/groupListings'

const props = defineProps({
  group: { type: Object, required: true },
  /** Open on mount — the review queue wants its single channel visible. */
  startExpanded: { type: Boolean, default: false },
})

defineEmits(['publish', 'delist', 'archive'])

const expanded = ref(props.startExpanded)

const summary = computed(() => summarise(props.group))

/**
 * Surfaces one error on the collapsed row. A product whose eBay listing failed
 * must not look healthy just because its Reverb listing is live.
 */
const firstError = computed(() => props.group.listings.find((l) => l.lastError))

function chipClass(status) {
  const base = 'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium border'
  const map = {
    ACTIVE:       'bg-green-500/10 text-green-400 border-green-500/30',
    NEEDS_REVIEW: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    PENDING:      'bg-gray-500/10 text-gray-400 border-gray-500/30',
    PUBLISHING:   'bg-gray-500/10 text-gray-400 border-gray-500/30',
    FAILED:       'bg-red-500/10 text-red-400 border-red-500/30',
    SOLD:         'bg-blue-500/10 text-blue-400 border-blue-500/30',
  }
  return `${base} ${map[status] || 'bg-gray-500/10 text-gray-500 border-gray-700'}`
}

/**
 * Matches the badge vocabulary in main.css. NEEDS_REVIEW has no badge-* class of
 * its own, so it carries the same explicit amber the Listings page has always
 * used for it.
 */
function statusBadge(status) {
  const map = {
    ACTIVE:       'badge-green',
    FAILED:       'badge-red',
    PENDING:      'badge-yellow',
    PUBLISHING:   'badge-blue',
    SOLD:         'badge-blue',
    DELISTED:     'badge-gray',
    INACTIVE:     'badge-gray',
    NEEDS_REVIEW: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-500/20 text-amber-300',
  }
  return map[status] || 'badge-gray'
}

function formatPrice(v) {
  if (v == null) return '—'
  return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(v) {
  if (!v) return '—'
  return new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
</script>
