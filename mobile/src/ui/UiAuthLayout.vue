<template>
  <main class="auth-screen">
    <section class="auth-card">
      <div class="auth-brand">
        <UiBrandMark class="brand-mark" />
        <span class="auth-brand-name">Кокпит</span>
      </div>
      <slot />
    </section>
  </main>
</template>

<script setup lang="ts">
import UiBrandMark from './UiBrandMark.vue';

defineOptions({ name: 'UiAuthLayout' });
</script>
