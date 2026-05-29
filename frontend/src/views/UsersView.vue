<template>
  <div class="flex flex-col h-full">
    <header class="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-800 px-6">
      <h1 class="text-lg font-semibold text-white">Users</h1>
      <button @click="openCreate" class="btn-primary text-xs">+ Invite User</button>
    </header>

    <div class="flex-1 overflow-auto p-6">
      <div v-if="loading" class="flex justify-center py-16">
        <div class="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"></div>
      </div>

      <div v-else class="overflow-hidden rounded-xl border border-gray-800">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-800 bg-gray-900">
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">User</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Role</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
              <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Last Login</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id" class="table-row">
              <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                  <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-xs font-medium text-brand-400">
                    {{ initials(u) }}
                  </div>
                  <div>
                    <p class="text-sm font-medium text-gray-200">{{ fullName(u) || u.email }}</p>
                    <p v-if="fullName(u)" class="text-xs text-gray-500">{{ u.email }}</p>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3">
                <span :class="roleBadge(u.role)">{{ u.role }}</span>
              </td>
              <td class="px-4 py-3">
                <span :class="u.active ? 'badge-green' : 'badge-gray'">
                  {{ u.active ? 'Active' : 'Inactive' }}
                </span>
              </td>
              <td class="px-4 py-3 text-xs text-gray-500">{{ formatDate(u.lastLoginAt) }}</td>
              <td class="px-4 py-3">
                <div class="flex items-center justify-end gap-3">
                  <button
                    @click="openResetPassword(u)"
                    class="text-xs text-gray-400 hover:text-white transition-colors"
                  >Reset password</button>
                  <button
                    v-if="u.active && u.id !== currentUserId"
                    @click="deactivate(u)"
                    class="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >Deactivate</button>
                  <button
                    v-else-if="!u.active"
                    @click="activate(u)"
                    class="text-xs text-brand-400 hover:text-brand-300 transition-colors"
                  >Reactivate</button>
                </div>
              </td>
            </tr>
            <tr v-if="users.length === 0">
              <td colspan="5" class="px-4 py-12 text-center text-sm text-gray-500">No users found</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── Create user modal ─────────────────────────────────── -->
    <div v-if="showCreate" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div class="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
        <h2 class="mb-5 text-base font-semibold text-white">Invite User</h2>
        <form @submit.prevent="submitCreate" class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="mb-1 block text-xs text-gray-400">First name</label>
              <input v-model="form.firstName" class="input w-full" placeholder="Jane" />
            </div>
            <div>
              <label class="mb-1 block text-xs text-gray-400">Last name</label>
              <input v-model="form.lastName" class="input w-full" placeholder="Smith" />
            </div>
          </div>
          <div>
            <label class="mb-1 block text-xs text-gray-400">Email <span class="text-red-400">*</span></label>
            <input v-model="form.email" type="email" required class="input w-full" placeholder="jane@example.com" />
          </div>
          <div>
            <label class="mb-1 block text-xs text-gray-400">Password <span class="text-red-400">*</span></label>
            <input v-model="form.password" type="password" required minlength="8" class="input w-full" placeholder="At least 8 characters" />
          </div>
          <div>
            <label class="mb-1 block text-xs text-gray-400">Role <span class="text-red-400">*</span></label>
            <select v-model="form.role" required class="input w-full">
              <option value="ADMIN">Admin</option>
              <option value="OPERATOR">Operator</option>
              <option value="VIEWER">Viewer</option>
            </select>
          </div>
          <p v-if="createError" class="text-xs text-red-400">{{ createError }}</p>
          <div class="flex justify-end gap-3 pt-2">
            <button type="button" @click="showCreate = false" class="btn-secondary text-xs">Cancel</button>
            <button type="submit" :disabled="creating" class="btn-primary text-xs">
              {{ creating ? 'Creating…' : 'Create User' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- ── Reset password modal ──────────────────────────────── -->
    <div v-if="showReset" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div class="w-full max-w-sm rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
        <h2 class="mb-1 text-base font-semibold text-white">Reset Password</h2>
        <p class="mb-5 text-xs text-gray-500">Set a new password for {{ resetTarget?.email }}</p>
        <form @submit.prevent="submitReset" class="space-y-4">
          <div>
            <label class="mb-1 block text-xs text-gray-400">New password <span class="text-red-400">*</span></label>
            <input v-model="resetPassword" type="password" required minlength="8" class="input w-full" placeholder="At least 8 characters" />
          </div>
          <p v-if="resetError" class="text-xs text-red-400">{{ resetError }}</p>
          <div class="flex justify-end gap-3 pt-2">
            <button type="button" @click="showReset = false" class="btn-secondary text-xs">Cancel</button>
            <button type="submit" :disabled="resetting" class="btn-primary text-xs">
              {{ resetting ? 'Saving…' : 'Save Password' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const currentUserId = computed(() => authStore.user?.id)

const users   = ref([])
const loading = ref(true)

// Create modal
const showCreate  = ref(false)
const creating    = ref(false)
const createError = ref('')
const form = ref({ email: '', password: '', firstName: '', lastName: '', role: 'OPERATOR' })

// Reset password modal
const showReset    = ref(false)
const resetting    = ref(false)
const resetError   = ref('')
const resetTarget  = ref(null)
const resetPassword = ref('')

async function load() {
  loading.value = true
  try {
    const res = await api.get('/admin/users')
    users.value = res.data
  } finally {
    loading.value = false
  }
}

function openCreate() {
  form.value = { email: '', password: '', firstName: '', lastName: '', role: 'OPERATOR' }
  createError.value = ''
  showCreate.value = true
}

async function submitCreate() {
  creating.value = true
  createError.value = ''
  try {
    await api.post('/admin/users', form.value)
    showCreate.value = false
    load()
  } catch (e) {
    createError.value = e.response?.status === 409
      ? 'A user with that email already exists.'
      : 'Failed to create user. Please try again.'
  } finally {
    creating.value = false
  }
}

function openResetPassword(u) {
  resetTarget.value = u
  resetPassword.value = ''
  resetError.value = ''
  showReset.value = true
}

async function submitReset() {
  resetting.value = true
  resetError.value = ''
  try {
    await api.post(`/admin/users/${resetTarget.value.id}/reset-password`, { password: resetPassword.value })
    showReset.value = false
  } catch (e) {
    resetError.value = 'Failed to reset password. Please try again.'
  } finally {
    resetting.value = false
  }
}

async function deactivate(u) {
  await api.delete(`/admin/users/${u.id}`)
  load()
}

async function activate(u) {
  await api.patch(`/admin/users/${u.id}`, { active: true })
  load()
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fullName(u) {
  const parts = [u.firstName, u.lastName].filter(Boolean)
  return parts.join(' ')
}

function initials(u) {
  if (u.firstName) return (u.firstName[0] + (u.lastName?.[0] || '')).toUpperCase()
  return u.email.slice(0, 2).toUpperCase()
}

function roleBadge(role) {
  return {
    ADMIN:    'badge-red',
    OPERATOR: 'badge-blue',
    VIEWER:   'badge-gray',
  }[role] || 'badge-gray'
}

function formatDate(d) {
  if (!d) return 'Never'
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

onMounted(load)
</script>
