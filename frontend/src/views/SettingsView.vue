<template>
  <div class="flex flex-col h-full">
    <header class="flex h-16 flex-shrink-0 items-center border-b border-gray-800 px-6">
      <h1 class="text-lg font-semibold text-white">Settings</h1>
    </header>

    <div class="flex-1 overflow-auto p-6 space-y-6">
      <!-- Account -->
      <div class="card">
        <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500">Account</h2>
        <dl class="space-y-3">
          <div class="flex items-center justify-between">
            <dt class="text-sm text-gray-400">Email</dt>
            <dd class="text-sm font-medium text-gray-200">{{ authStore.user?.email }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-sm text-gray-400">Role</dt>
            <dd><span class="badge-blue">{{ authStore.user?.role }}</span></dd>
          </div>
        </dl>
      </div>

      <!-- Marketplace integrations -->
      <div class="card">
        <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500">Marketplace Integrations</h2>
        <div class="space-y-3">
          <div class="flex items-center justify-between rounded-lg border border-gray-800 p-4">
            <div>
              <p class="font-medium text-gray-200">Shopify</p>
              <p class="text-xs text-gray-500 mt-0.5">Source of truth for inventory and products</p>
            </div>
            <router-link to="/marketplaces" class="btn-secondary px-3 py-1.5 text-xs">Manage</router-link>
          </div>
          <div class="flex items-center justify-between rounded-lg border border-gray-800 p-4">
            <div>
              <p class="font-medium text-gray-200">Reverb</p>
              <p class="text-xs text-gray-500 mt-0.5">Music gear marketplace — reference connector</p>
            </div>
            <router-link to="/marketplaces" class="btn-secondary px-3 py-1.5 text-xs">Manage</router-link>
          </div>
          <div class="flex items-center justify-between rounded-lg border border-gray-800 p-4">
            <div>
              <p class="font-medium text-gray-200">eBay</p>
              <p class="text-xs text-gray-500 mt-0.5">Connector available — implementation in progress</p>
            </div>
            <router-link to="/marketplaces" class="btn-secondary px-3 py-1.5 text-xs">Manage</router-link>
          </div>
        </div>
      </div>

      <!-- Danger zone -->
      <div class="card border-red-900/50">
        <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-red-500">Account Actions</h2>
        <button @click="authStore.logout()" class="btn-danger">
          Sign Out
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useAuthStore } from '@/stores/auth'
const authStore = useAuthStore()
</script>
