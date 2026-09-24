<script setup>
import { state, start } from './store.js'
import TosGate from './components/TosGate.vue'
import AppShell from './components/AppShell.vue'
start()
</script>

<template>
  <TosGate v-if="!state.tosAccepted" />
  <AppShell v-else><RouterView /></AppShell>
</template>
