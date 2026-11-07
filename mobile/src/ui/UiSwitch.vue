<template>
  <button
    type="button"
    class="mobile-switch"
    role="switch"
    :aria-checked="value"
    @click="value = !value"
  >
    <span class="mobile-switch-track" aria-hidden="true"><span /></span>
    <span class="mobile-switch-label"><slot /></span>
  </button>
</template>

<script setup lang="ts">
const value = defineModel<boolean>({ default: false });
</script>
