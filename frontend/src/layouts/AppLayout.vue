<template>
  <div class="flex h-screen overflow-hidden bg-gray-950">
    <!-- Sidebar -->
    <aside class="flex w-64 flex-shrink-0 flex-col border-r border-gray-800 bg-gray-900">
      <!-- Logo -->
      <div class="flex h-16 items-center gap-3 border-b border-gray-800 px-5">
        <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500">
          <svg class="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <span class="text-lg font-bold tracking-tight text-white">Gearline</span>
      </div>

      <!-- Navigation -->
      <nav class="flex-1 overflow-y-auto px-3 py-4">
        <div class="space-y-0.5">
          <NavItem to="/dashboard" icon="home">Dashboard</NavItem>
          <NavItem to="/products" icon="package">Products</NavItem>
          <NavItem to="/listings" icon="tag">Listings</NavItem>
          <NavItem to="/orders" icon="shopping-bag">Orders</NavItem>
          <div class="my-3 border-t border-gray-800"></div>
          <NavItem to="/marketplaces" icon="link">Marketplaces</NavItem>
          <NavItem to="/sync" icon="refresh">Sync Activity</NavItem>
          <NavItem to="/audit" icon="clipboard">Audit Logs</NavItem>
          <div class="my-3 border-t border-gray-800"></div>
          <NavItem to="/settings" icon="settings">Settings</NavItem>
        </div>
      </nav>

      <!-- User footer -->
      <div class="border-t border-gray-800 p-3">
        <div class="flex items-center gap-3 rounded-lg px-3 py-2">
          <div class="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500/20 text-sm font-medium text-brand-400">
            {{ userInitials }}
          </div>
          <div class="flex-1 min-w-0">
            <p class="truncate text-sm font-medium text-gray-200">{{ authStore.user?.email }}</p>
            <p class="text-xs text-gray-500">{{ authStore.user?.role }}</p>
          </div>
          <button @click="authStore.logout()" class="text-gray-500 hover:text-gray-300 transition-colors" title="Sign out">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex flex-1 flex-col overflow-hidden">
      <router-view />
    </main>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import NavItem from '@/components/ui/NavItem.vue'

const authStore = useAuthStore()
const userInitials = computed(() => {
  const email = authStore.user?.email || ''
  return email.slice(0, 2).toUpperCase()
})
</script>
