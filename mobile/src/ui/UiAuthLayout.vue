<template>
  <main class="auth-screen">
    <section class="auth-card">
      <div class="auth-brand">
        <span class="brand-mark" aria-hidden="true">◧</span>
        <span class="auth-brand-name">Кокпит</span>
      </div>
      <slot />
    </section>
  </main>
</template>

<script setup lang="ts">
defineOptions({ name: 'UiAuthLayout' });
</script>
