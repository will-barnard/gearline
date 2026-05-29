<template>
  <div class="stat-card">
    <p class="text-xs font-medium uppercase tracking-wider" :class="labelColor">{{ label }}</p>
    <p class="mt-2 text-3xl font-bold text-white">
      <span v-if="loading" class="inline-block h-8 w-16 animate-pulse rounded bg-gray-800"></span>
      <span v-else>{{ value.toLocaleString() }}</span>
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({ label: String, value: Number, color: String, loading: Boolean })
const labelColor = computed(() => ({
  green: 'text-green-400',
  red: 'text-red-400',
  yellow: 'text-yellow-400',
  blue: 'text-blue-400',
  gray: 'text-gray-400'
}[props.color] || 'text-gray-400'))
</script>
