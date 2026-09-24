<template>
  <div class="nf">
    <div class="nf-code">404</div>
    <h1 class="nf-title">Page <span class="serif">not found</span></h1>
    <p class="nf-sub">The page you're looking for doesn't exist or has moved.</p>
    <RouterLink to="/" class="nf-btn">Back to markets</RouterLink>
  </div>
</template>

<style scoped>
.nf { min-height: 60vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 40px; }
.nf-code { font-weight: 700; font-size: 120px; line-height: 1; letter-spacing: -.04em; background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
.nf-title { font-weight: 600; font-size: 34px; margin-top: 8px; }
.nf-title .serif { color: var(--m1); }
.nf-sub { color: var(--n-text-3); font-size: 15px; margin-top: 12px; }
.nf-btn { margin-top: 28px; font-weight: 600; font-size: 14px; color: #fff; background: var(--grad); padding: 13px 24px; border-radius: 999px; transition: transform .15s, box-shadow .2s; }
.nf-btn:hover { transform: translateY(-1px); box-shadow: 0 12px 30px -8px #ec008c99; }
</style>
