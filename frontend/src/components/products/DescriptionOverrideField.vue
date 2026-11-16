<template>
  <div class="space-y-1.5">
    <div class="flex items-center justify-between gap-2">
      <label class="text-xs text-gray-500" :class="size === 'sm' ? 'font-medium text-gray-400' : ''">Description override</label>
      <div class="flex items-center gap-3">
        <button
          v-if="modelValue"
          type="button"
          class="text-xs text-brand-400 hover:text-brand-300"
          title="Clear this override so the listing uses the Shopify description again"
          @click="$emit('update:modelValue', '')"
        >↺ Use Shopify's description</button>
        <span v-if="limit" class="text-xs tabular-nums" :class="counterClass">{{ sent.length }}/{{ limit }}</span>
      </div>
    </div>

    <textarea
      :value="modelValue"
      @input="$emit('update:modelValue', $event.target.value)"
      :placeholder="fallback || placeholder"
      rows="4"
      class="input w-full mt-0 resize-none"
      :class="[size === 'sm' ? 'py-1.5 text-sm' : 'py-1 text-xs', over ? 'border-red-500' : '']"
    ></textarea>

    <!--
      The switch, not a button: it is saved with the listing and applied by the
      server each time the description is sent, so editing the copy in Shopify
      still flows through — already cleaned.
    -->
    <label class="flex items-start gap-2 text-xs text-gray-400 cursor-pointer select-none">
      <input
        type="checkbox"
        class="mt-0.5"
        :checked="stripLinks"
        @change="$emit('update:stripLinks', $event.target.checked)"
      />
      <span>
        Remove links from the description
        <span v-if="linkCount > 0" class="text-yellow-400">
          — {{ linkCount }} {{ linkCount === 1 ? 'link' : 'links' }} in the current copy
        </span>
        <span v-else class="text-gray-600">— none in the current copy</span>
      </span>
    </label>

    <p v-if="stripLinks && linkCount > 0" class="text-xs text-green-400">
      They're taken out when this is sent to {{ marketplace }}. Edits to the description in Shopify still carry over.
    </p>
    <p v-else-if="!stripLinks && linkCount > 0" class="text-xs text-yellow-400">
      ⚠ The description has {{ linkCount }} {{ linkCount === 1 ? 'link' : 'links' }} and will be sent as-is.
    </p>
    <p v-if="stripLinks && modelValue" class="text-xs text-gray-500">
      This listing has its own description override, so Shopify edits to the description won't carry over
      until you use Shopify's description (↺ above).
    </p>
    <p v-if="over" class="text-xs text-red-400">
      Exceeds the {{ limit }}-character limit. Trim the description or it will be rejected.
    </p>
  </div>
</template>

<script setup>
/**
 * Description override box + "Remove links" switch.
 *
 * Link removal is a SETTING on the listing (listing_overrides.strip_links), not
 * an edit to the text. The server applies it to whatever description is current
 * each time it sends the listing — the override if one is set, otherwise the
 * product's Shopify description. An earlier version wrote a cleaned copy into
 * the override instead; that pinned the text, so a later edit in Shopify never
 * reached the listing.
 *
 * The count and character total here are a live preview of what the server will
 * do (frontend/src/lib/stripLinks.js mirrors the backend's description-links.ts).
 */
import { computed } from 'vue'
import { countLinks, stripLinks as removeLinks } from '@/lib/stripLinks'

const props = defineProps({
  modelValue: { type: String, default: '' },
  stripLinks: { type: Boolean, default: false },
  /** product.description — what is sent when the override is blank. */
  fallback: { type: String, default: '' },
  /** Marketplace character limit, when there is a known one. */
  limit: { type: Number, default: 0 },
  placeholder: { type: String, default: 'Override the description for this marketplace' },
  marketplace: { type: String, default: 'the marketplace' },
  size: { type: String, default: 'xs' },
})
defineEmits(['update:modelValue', 'update:stripLinks'])

const effective = computed(() => props.modelValue || props.fallback || '')
const linkCount = computed(() => countLinks(effective.value))
// What will actually be sent: the counter and the over-limit check use this.
const sent = computed(() => (props.stripLinks ? removeLinks(effective.value) : effective.value))
const over = computed(() => !!props.limit && sent.value.length > props.limit)
const counterClass = computed(() => {
  if (over.value) return 'text-red-400'
  return sent.value.length >= props.limit * 0.9 ? 'text-yellow-400' : 'text-gray-500'
})
</script>
