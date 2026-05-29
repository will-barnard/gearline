<template>
  <router-link
    :to="to"
    class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors"
    :class="isActive
      ? 'bg-brand-500/10 text-brand-400'
      : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'"
  >
    <slot />
  </router-link>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const props = defineProps({ to: String, icon: String })
const route = useRoute()
const isActive = computed(() => route.path === props.to || route.path.startsWith(props.to + '/'))
</script>
