<script setup>
// Collapsible card section (native <details>, so keyboard + screen readers work out of the box).
defineProps({ title: String, open: Boolean })
</script>

<template>
  <details class="n-acc" :open="open">
    <summary>
      <span class="n-acc-t">{{ title }}</span>
      <span class="n-acc-meta"><slot name="meta" /></span>
      <svg class="n-acc-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </summary>
    <div class="n-acc-body"><slot /></div>
  </details>
</template>
