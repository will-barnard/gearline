<template>
  <div class="flex min-h-screen items-center justify-center bg-gray-950 px-4">
    <div class="w-full max-w-sm">
      <!-- Logo -->
      <div class="mb-8 flex flex-col items-center gap-3">
        <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-500">
          <svg class="h-7 w-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <div class="text-center">
          <h1 class="text-2xl font-bold text-white">Gearline</h1>
          <p class="mt-1 text-sm text-gray-500">Marketplace Control Center</p>
        </div>
      </div>

      <!-- Form -->
      <div class="card">
        <form @submit.prevent="handleLogin" class="space-y-4">
          <div>
            <label class="mb-1.5 block text-sm font-medium text-gray-400">Email</label>
            <input
              v-model="form.email"
              type="email"
              class="input"
              placeholder="admin@gearline.io"
              autocomplete="email"
              required
            />
          </div>
          <div>
            <label class="mb-1.5 block text-sm font-medium text-gray-400">Password</label>
            <input
              v-model="form.password"
              type="password"
              class="input"
              placeholder="••••••••"
              autocomplete="current-password"
              required
            />
          </div>

          <div v-if="error" class="rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-400">
            {{ error }}
          </div>

          <button type="submit" class="btn-primary w-full justify-center" :disabled="loading">
            <svg v-if="loading" class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            {{ loading ? 'Signing in…' : 'Sign in' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const form = ref({ email: '', password: '' })
const error = ref(null)
const loading = ref(false)

async function handleLogin() {
  loading.value = true
  error.value = null
  try {
    await auth.login(form.value.email, form.value.password)
    const redirect = route.query.redirect || '/dashboard'
    router.push(redirect)
  } catch (e) {
    error.value = e.response?.data?.detail || 'Invalid email or password'
  } finally {
    loading.value = false
  }
}
</script>
