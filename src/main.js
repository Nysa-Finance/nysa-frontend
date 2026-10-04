import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { startAnalytics } from './analytics.js'
import App from './App.vue'
import './style.css'

const router = createRouter({
  history: createWebHistory(),
  // New page → top; same page with different query (e.g. switching Lend/Borrow panel) → keep position.
  scrollBehavior: (to, from) => (to.path === from.path ? false : { top: 0 }),
  routes: [
    { path: '/', name: 'markets', component: () => import('./pages/Markets.vue') },
    { path: '/lend', name: 'lend', component: () => import('./pages/Lend.vue') },
    { path: '/borrow', name: 'borrow', component: () => import('./pages/Borrow.vue') },
    { path: '/portfolio', name: 'portfolio', component: () => import('./pages/Portfolio.vue') },
    { path: '/market/:id', name: 'market-detail', component: () => import('./pages/MarketDetail.vue') },
    { path: '/analytics', name: 'analytics', component: () => import('./pages/Analytics.vue') },
    { path: '/dashboard', redirect: { name: 'markets' } },
    { path: '/debug-transfer', component: () => import('./pages/DebugTransfer.vue') }, // TEMPORARY Phantom test, not linked
    { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('./pages/NotFound.vue') },
  ],
})

createApp(App).use(router).mount('#app')
startAnalytics()
