<script setup>
// The rewards marker: the design system's bolt (24px grid, 2px round stroke), never the ⚡ emoji.
defineProps({ title: String })
</script>

<template>
  <span class="n-boost" role="img" :title="title" :aria-label="title ?? 'Includes rewards'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg></span>
</template>
