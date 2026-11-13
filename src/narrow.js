import { ref } from 'vue'

// Phones and narrow tablets: the same breakpoint as the 860px blocks in the CSS.
const query = globalThis.matchMedia?.('(max-width: 860px)')
export const narrow = ref(!!query?.matches)
query?.addEventListener('change', (e) => { narrow.value = e.matches })
