<template>
  <div class="tool-route-adapter" :data-tool-route="`ext:${$route.params.id}`" aria-hidden="true"></div>
</template>

<script setup lang="ts">
// Маршрут объявляет цель, а постоянный ToolHost владеет единственной панелью.
// Узкое окно и док используют один экземпляр модуля.
</script>
