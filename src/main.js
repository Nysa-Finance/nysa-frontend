import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { startAnalytics } from './analytics.js'
import { applySeo } from './seo.js'
import App from './App.vue'
import { VAULTS } from './config.js'
// Fonts served from our own origin (no Google Fonts request): only the weights and styles the UI uses, latin subset.
import '@fontsource/poppins/latin-300.css'
import '@fontsource/poppins/latin-400.css'
import '@fontsource/poppins/latin-500.css'
import '@fontsource/poppins/latin-600.css'
import '@fontsource/poppins/latin-700.css'
import '@fontsource/instrument-serif/latin-400-italic.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import './style.css'

const router = createRouter({
  history: createWebHistory(),
  // New page → top; same page with different query (e.g. switching a panel's tab) → keep position.
  scrollBehavior: (to, from) => (to.path === from.path ? false : { top: 0 }),
  routes: [
    { path: '/', redirect: { name: 'earn' } },
    { path: '/earn', name: 'earn', component: () => import('./pages/Earn.vue') },
    { path: '/earn/:id', name: 'vault', component: () => import('./pages/VaultDetail.vue') },
    { path: '/borrow', name: 'borrow', component: () => import('./pages/Borrow.vue') },
    { path: '/borrow/:id', name: 'market-detail', component: () => import('./pages/MarketDetail.vue') },
    { path: '/portfolio', name: 'portfolio', component: () => import('./pages/Portfolio.vue') },
    // Old links: Lend is now Earn (the vault); a market page is now its borrow page.
    { path: '/lend', redirect: { name: 'earn' } },
    { path: '/market/:id', redirect: (to) => (to.query.mode === 'lend' && VAULTS[0] ? { name: 'vault', params: { id: VAULTS[0].id } } : { name: 'market-detail', params: to.params, query: to.query }) },
    { path: '/analytics', name: 'analytics', component: () => import('./pages/Analytics.vue') },
    { path: '/liquidations', name: 'liquidations', component: () => import('./pages/Liquidations.vue') },
    { path: '/dashboard', redirect: { name: 'earn' } },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('./pages/NotFound.vue') },
  ],
})

router.afterEach(applySeo)

createApp(App).use(router).mount('#app')
startAnalytics()
