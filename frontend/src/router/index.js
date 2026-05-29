import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true }
  },
  {
    path: '/',
    component: () => import('@/layouts/AppLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'Dashboard', component: () => import('@/views/DashboardView.vue') },
      { path: 'products', name: 'Products', component: () => import('@/views/ProductsView.vue') },
      { path: 'products/:id', name: 'ProductDetail', component: () => import('@/views/ProductDetailView.vue') },
      { path: 'listings', name: 'Listings', component: () => import('@/views/ListingsView.vue') },
      { path: 'orders', name: 'Orders', component: () => import('@/views/OrdersView.vue') },
      { path: 'marketplaces', name: 'Marketplaces', component: () => import('@/views/MarketplacesView.vue') },
      { path: 'sync', name: 'SyncActivity', component: () => import('@/views/SyncActivityView.vue') },
      { path: 'audit', name: 'AuditLogs', component: () => import('@/views/AuditLogsView.vue') },
      { path: 'settings', name: 'Settings', component: () => import('@/views/SettingsView.vue') }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: 'Login', query: { redirect: to.fullPath } }
  }
  if (to.name === 'Login' && auth.isAuthenticated) {
    return { name: 'Dashboard' }
  }
})

export default router
