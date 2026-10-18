<template>
  <svg class="ui-brand-mark" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
    <path :d="MARK" />
  </svg>
</template>

<script setup lang="ts">
// Малая G для тёмного фона из grigdesk-g-small-reversed.svg.
// Генератор переносит контур без изменений; размер и цвет задаёт место использования.
const MARK = 'M236 44.7H77.63C45.8 44.7 20 70.5 20 102.33V153.67C20 185.5 45.8 211.3 77.63 211.3H17'
  + '8.37C210.2 211.3 236 185.5 236 153.67V120.25H122.91V159.48H177.88V161.66C177.88 167.2'
  + '8 173.33 171.83 167.71 171.83H88.29C82.67 171.83 78.12 167.28 78.12 161.66V94.34C78.1'
  + '2 88.72 82.67 84.17 88.29 84.17H236Z';
</script>

<style scoped>
:where(.ui-brand-mark) {
  width: 1em;
  height: 1em;
  flex: none;
}

path {
  fill: currentColor;
}
</style>
