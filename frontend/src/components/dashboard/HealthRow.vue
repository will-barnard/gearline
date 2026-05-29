<template>
  <div class="flex items-center justify-between rounded-lg border border-gray-800 px-4 py-3">
    <span class="text-sm text-gray-300">{{ label }}</span>
    <div class="flex items-center gap-3">
      <span class="text-xs text-gray-500">{{ detail }}</span>
      <span :class="healthy ? 'badge-green' : 'badge-red'">
        {{ healthy ? 'Healthy' : 'Issues' }}
      </span>
    </div>
  </div>
</template>

<script setup>
defineProps({ label: String, healthy: Boolean, detail: String })
</script>
