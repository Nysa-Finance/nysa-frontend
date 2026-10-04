import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { startAnalytics } from './analytics.js'
import { applySeo } from './seo.js'
import App from './App.vue'
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
    { path: '/debug-transfer', component: () => import('./pages/DebugTransfer.vue'), meta: { noindex: true } }, // TEMPORARY Phantom test, not linked
    { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('./pages/NotFound.vue') },
  ],
})

router.afterEach(applySeo)

createApp(App).use(router).mount('#app')
startAnalytics()
