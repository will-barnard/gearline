<template>
  <div class="flex flex-col h-full">
    <header class="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-800 px-6">
      <h1 class="text-lg font-semibold text-white">Sync Activity</h1>
      <div class="flex items-center gap-3">
        <select v-model="statusFilter" class="input w-44 py-1.5 text-xs">
          <option value="">All statuses</option>
          <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
        </select>
        <button
          v-if="hasQueuedJobs"
          @click="cancelAllQueued"
          :disabled="cancelling"
          class="btn-secondary px-3 py-1.5 text-xs text-red-400 border-red-800 hover:border-red-600 disabled:opacity-50"
        >
          {{ cancelling ? 'Cancelling…' : 'Cancel all queued' }}
        </button>
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
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Type</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Marketplace</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
              <th class="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500">Retries</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Created</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Failure</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="job in jobs" :key="job.id" class="table-row">
              <td class="px-4 py-3 text-xs font-mono text-gray-300">{{ job.jobType }}</td>
              <td class="px-4 py-3">
                <span v-if="job.marketplaceType" class="badge-blue">{{ job.marketplaceType }}</span>
                <span v-else class="text-gray-600">—</span>
              </td>
              <td class="px-4 py-3">
                <span :class="statusBadge(job.status)">{{ job.status }}</span>
              </td>
              <td class="px-4 py-3 text-center text-xs text-gray-400">{{ job.retryCount }}/{{ job.maxRetries }}</td>
              <td class="px-4 py-3 text-xs text-gray-500">{{ formatDate(job.createdAt) }}</td>
              <td class="px-4 py-3 max-w-xs">
                <span v-if="job.failureReason" class="text-xs text-red-400 truncate block" :title="job.failureReason">
                  {{ job.failureReason }}
                </span>
              </td>
              <td class="px-4 py-3 text-right">
                <button
                  v-if="['FAILED','DEAD_LETTERED'].includes(job.status)"
                  @click="replayJob(job.id)"
                  class="text-xs text-brand-400 hover:text-brand-300"
                >
                  Replay
                </button>
                <button
                  v-if="job.status === 'QUEUED'"
                  @click="cancelJob(job.id)"
                  class="text-xs text-red-400 hover:text-red-300 ml-2"
                >
                  Cancel
                </button>
              </td>
            </tr>
            <tr v-if="jobs.length === 0">
              <td colspan="7" class="px-4 py-12 text-center text-sm text-gray-500">No sync jobs found</td>
            </tr>
          </tbody>
        </table>

        <div v-if="totalPages > 1" class="flex items-center justify-between border-t border-gray-800 px-4 py-3">
          <span class="text-xs text-gray-500">{{ totalElements }} jobs</span>
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
import { ref, computed, watch, onMounted } from 'vue'
import api from '@/lib/api'

const jobs = ref([])
const loading = ref(true)
const cancelling = ref(false)
const page = ref(0)
const totalPages = ref(1)
const totalElements = ref(0)
const statusFilter = ref('')
const statuses = ['QUEUED','IN_PROGRESS','COMPLETED','FAILED','DEAD_LETTERED','CANCELLED']

// True whenever the current page contains at least one QUEUED job — used to show
// the "Cancel all queued" button. We check totalElements too to catch the case
// where the user filtered to QUEUED status and there are multiple pages.
const hasQueuedJobs = computed(() =>
  jobs.value.some(j => j.status === 'QUEUED') ||
  (statusFilter.value === 'QUEUED' && totalElements.value > 0)
)

async function load() {
  loading.value = true
  try {
    const res = await api.get('/sync/jobs', { params: { page: page.value, size: 50, status: statusFilter.value || undefined } })
    jobs.value = res.data.content
    totalPages.value = res.data.totalPages
    totalElements.value = res.data.totalElements
  } finally { loading.value = false }
}

async function replayJob(id) {
  await api.post(`/sync/jobs/${id}/replay`)
  load()
}

async function cancelJob(id) {
  await api.post(`/sync/jobs/${id}/cancel`)
  load()
}

async function cancelAllQueued() {
  if (!confirm('Cancel ALL queued sync jobs? This cannot be undone.')) return
  cancelling.value = true
  try {
    const res = await api.post('/sync/jobs/cancel-queued')
    const n = res.data?.cancelled ?? '?'
    alert(`Cancelled ${n} queued job${n === 1 ? '' : 's'}.`)
    load()
  } catch (e) {
    alert('Failed to cancel queued jobs. Check that you have ADMIN role.')
  } finally {
    cancelling.value = false
  }
}

function statusBadge(s) {
  return { COMPLETED: 'badge-green', FAILED: 'badge-red', IN_PROGRESS: 'badge-blue', QUEUED: 'badge-yellow', DEAD_LETTERED: 'badge-red', CANCELLED: 'badge-gray' }[s] || 'badge-gray'
}

function formatDate(d) { return d ? new Date(d).toLocaleString() : '—' }

watch([page, statusFilter], load)
onMounted(load)
</script>
