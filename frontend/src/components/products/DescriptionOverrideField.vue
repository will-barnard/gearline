<template>
  <div>
    <div class="flex items-center justify-between mb-1 gap-2">
      <label class="text-xs text-gray-500" :class="size === 'sm' ? 'font-medium text-gray-400' : ''">Description override</label>
      <div class="flex items-center gap-3">
        <button
          v-if="previous !== null"
          type="button"
          class="text-xs text-gray-500 hover:text-gray-300 underline underline-offset-2"
          @click="undo"
        >Undo</button>
        <button
          v-if="linkCount > 0"
          type="button"
          class="text-xs text-brand-400 hover:text-brand-300"
          title="Saves a link-free copy as this listing's description override. The Shopify description is not touched."
          @click="removeLinks"
        >✂ Remove {{ linkCount }} {{ linkCount === 1 ? 'link' : 'links' }}</button>
        <span v-if="limit" class="text-xs tabular-nums" :class="counterClass">{{ effective.length }}/{{ limit }}</span>
      </div>
    </div>

    <textarea
      :value="modelValue"
      @input="onInput"
      :placeholder="fallback || placeholder"
      rows="4"
      class="input w-full mt-0 resize-none"
      :class="[size === 'sm' ? 'py-1.5 text-sm' : 'py-1 text-xs', over ? 'border-red-500' : '']"
    ></textarea>

    <p v-if="linkCount > 0 && !modelValue" class="mt-1 text-xs text-yellow-400">
      ⚠ The product description has {{ linkCount }} {{ linkCount === 1 ? 'link' : 'links' }} and will be sent as-is.
    </p>
    <p v-else-if="linkCount > 0" class="mt-1 text-xs text-yellow-400">
      ⚠ This description override still has {{ linkCount }} {{ linkCount === 1 ? 'link' : 'links' }}.
    </p>
    <p v-else-if="previous !== null" class="mt-1 text-xs text-green-400">
      Links removed. Save to keep this as the listing's description.
    </p>
    <p v-if="over" class="mt-1 text-xs text-red-400">
      Exceeds the {{ limit }}-character limit. Trim the description or it will be rejected.
    </p>
  </div>
</template>

<script setup>
/**
 * Description override box with a "Remove links" action.
 *
 * Removing links writes the cleaned text into the *override*, never into the
 * product: the Shopify body_html stays as it is, so a Shopify resync can't undo
 * it and the other marketplaces keep their own choice. What gets cleaned is the
 * description that would actually be sent — the override if one is set,
 * otherwise the product description.
 *
 * The button only shows while the effective description contains a link, so
 * there's nothing to click once it's clean. "Undo" restores whatever the box
 * held before (including blank, i.e. "use the product description").
 */
import { ref, computed, watch } from 'vue'
import { countLinks, stripLinks } from '@/lib/stripLinks'

const props = defineProps({
  modelValue: { type: String, default: '' },
  /** product.description — what is sent when the override is blank. */
  fallback: { type: String, default: '' },
  /** Marketplace character limit, when there is a known one. */
  limit: { type: Number, default: 0 },
  placeholder: { type: String, default: 'Override the description for this marketplace' },
  size: { type: String, default: 'xs' },
})
const emit = defineEmits(['update:modelValue'])

const previous = ref(null)

const effective = computed(() => props.modelValue || props.fallback || '')
const linkCount = computed(() => countLinks(effective.value))
const over = computed(() => !!props.limit && effective.value.length > props.limit)
const counterClass = computed(() => {
  if (over.value) return 'text-red-400'
  return effective.value.length >= props.limit * 0.9 ? 'text-yellow-400' : 'text-gray-500'
})

function removeLinks() {
  previous.value = props.modelValue
  emit('update:modelValue', stripLinks(effective.value))
}

function undo() {
  emit('update:modelValue', previous.value ?? '')
  previous.value = null
}

function onInput(e) {
  previous.value = null
  emit('update:modelValue', e.target.value)
}

// The parent swaps this field's value when it applies "Copy from another size"
// or reopens a different listing; a stale Undo from before that would be wrong.
watch(() => props.fallback, () => { previous.value = null })
</script>
