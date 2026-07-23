<script setup>
// Телепортирует содержимое в слот действий топбара (#tb-slot в AppShell).
// Любой экран оборачивает свои кнопки в <TopbarActions>…</TopbarActions> — они появляются
// в топбаре и исчезают при уходе с экрана. Унификация места действий.
</script>

<template>
  <Teleport to="#tb-slot">
    <div class="tba">
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.tba { display: flex; align-items: center; gap: 8px; min-width: 0; }
</style>
