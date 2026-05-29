import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/lib/api'
import router from '@/router'

export const useAuthStore = defineStore('auth', () => {
  const accessToken = ref(localStorage.getItem('gearline_token') || null)
  const user = ref(JSON.parse(localStorage.getItem('gearline_user') || 'null'))

  const isAuthenticated = computed(() => !!accessToken.value)

  async function login(email, password) {
    const res = await api.post('/auth/login', { email, password })
    accessToken.value = res.data.accessToken
    user.value = {
      id: res.data.userId,
      email: res.data.email,
      role: res.data.role
    }
    localStorage.setItem('gearline_token', res.data.accessToken)
    localStorage.setItem('gearline_refresh', res.data.refreshToken)
    localStorage.setItem('gearline_user', JSON.stringify(user.value))
  }

  async function logout() {
    accessToken.value = null
    user.value = null
    localStorage.removeItem('gearline_token')
    localStorage.removeItem('gearline_refresh')
    localStorage.removeItem('gearline_user')
    router.push('/login')
  }

  async function refreshToken() {
    const refreshToken = localStorage.getItem('gearline_refresh')
    if (!refreshToken) { logout(); return }
    try {
      const res = await api.post('/auth/refresh', { refreshToken })
      accessToken.value = res.data.accessToken
      localStorage.setItem('gearline_token', res.data.accessToken)
    } catch {
      logout()
    }
  }

  return { accessToken, user, isAuthenticated, login, logout, refreshToken }
})
