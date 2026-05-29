<template>
  <div class="flex flex-col h-full">
    <header class="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-800 px-6">
      <h1 class="text-lg font-semibold text-white">Audit Logs</h1>
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" v-model="errorsOnly" class="rounded border-gray-700 bg-gray-800" />
          Failures only
        </label>
        <button @click="load" class="btn-secondary px-3 py-1.5 text-xs">Refresh</button>
      </div>
    </header>

    <div class="flex-1 overflow-auto p-6">
      <div v-if="loading" class="flex justify-center py-16">
        <div class="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"></div>
      </div>

      <div v-else class="overflow-hidden rounded-xl border border-gray-800">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 bg-gray-900">
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Event</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Marketplace</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Entity</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Result</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Time</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Error</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in events" :key="e.id" class="table-row">
              <td class="px-4 py-3 text-xs font-mono text-gray-300">{{ e.eventType }}</td>
              <td class="px-4 py-3">
                <span v-if="e.marketplaceType" class="badge-blue">{{ e.marketplaceType }}</span>
              </td>
              <td class="px-4 py-3 text-xs text-gray-500">
                <span v-if="e.entityType">{{ e.entityType }}</span>
              </td>
              <td class="px-4 py-3">
                <span :class="e.success ? 'badge-green' : 'badge-red'">
                  {{ e.success ? 'OK' : 'FAIL' }}
                </span>
              </td>
              <td class="px-4 py-3 text-xs text-gray-500">{{ formatDate(e.createdAt) }}</td>
              <td class="px-4 py-3 max-w-xs">
                <span v-if="e.errorMessage" class="text-xs text-red-400 truncate block" :title="e.errorMessage">
                  {{ e.errorMessage }}
                </span>
              </td>
            </tr>
            <tr v-if="events.length === 0">
              <td colspan="6" class="px-4 py-12 text-center text-sm text-gray-500">No audit events found</td>
            </tr>
          </tbody>
        </table>

        <div v-if="totalPages > 1" class="flex items-center justify-between border-t border-gray-800 px-4 py-3">
          <span class="text-xs text-gray-500">{{ totalElements }} events</span>
          <div class="flex gap-2">
            <button @click="page--" :disabled="page === 0" class="btn-secondary px-3 py-1 text-xs">←</button>
            <span class="px-3 py-1 text-xs text-gray-400">{{ page + 1 }} / {{ totalPages }}</span>
            <button @click="page++" :disabled="page >= totalPages - 1" class="btn-secondary px-3 py-1 text-xs">→</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import api from '@/lib/api'

const events = ref([])
const loading = ref(true)
const page = ref(0)
const totalPages = ref(1)
const totalElements = ref(0)
const errorsOnly = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await api.get('/audit', { params: { page: page.value, size: 50, successOnly: errorsOnly.value ? false : undefined } })
    events.value = res.data.content
    totalPages.value = res.data.totalPages
    totalElements.value = res.data.totalElements
  } finally { loading.value = false }
}

function formatDate(d) { return d ? new Date(d).toLocaleString() : '—' }

watch([page, errorsOnly], load)
onMounted(load)
</script>
