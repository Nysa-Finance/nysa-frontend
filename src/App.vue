<script setup>
import { state, start } from './store.js'
import TosGate from './components/TosGate.vue'
import AppShell from './components/AppShell.vue'
start()
</script>

<template>
  <!-- The page renders under the Terms of Service dialog (inert until accepted), so crawlers index the real content. -->
  <AppShell :inert="!state.tosAccepted"><RouterView /></AppShell>
  <TosGate v-if="!state.tosAccepted" />
</template>
