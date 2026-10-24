<template>
  <Teleport to="#tb-slot">
    <div class="tba">
      <slot />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// Телепортирует содержимое в слот действий топбара (#tb-slot в AppShell).
// Любой экран оборачивает свои кнопки в <TopbarActions>…</TopbarActions> — они появляются
// в топбаре и исчезают при уходе с экрана. Унификация места действий.
</script>

<style scoped>
.tba { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; }

.tba :deep(.title) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
