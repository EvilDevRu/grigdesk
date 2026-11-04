<template>
  <svg class="ui-brand-mark" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
    <path :d="PART_0" fill="#AD5839" transform="translate(24 12)" />
    <path :d="PART_1" fill="#F5C44C" />
    <path :d="PART_2" fill="#20233B" transform="translate(35.264 54.763) scale(0.51)" />
  </svg>
</template>

<script setup lang="ts">
// L3 «Янтарь»: исходная G и две цветные плоскости из мастера приложения.
// Генератор сохраняет геометрию; место использования задаёт только размер.
const PART_0 = 'M56 12H168L216 60V180L168 228H56Q16 228 16 188V52Q16 12 56 12Z';
const PART_1 = 'M56 12H168L216 60V180L168 228H56Q16 228 16 188V52Q16 12 56 12Z';
const PART_2 = 'M316.61 4.15H82.75C37.05 4.15 0 41.2 0 86.9V168.93C0 214.64 37.05 251.68 82.75 251.68'
  + 'H233.86C279.56 251.68 316.61 214.64 316.61 168.93V109.93H149.31V161.74H242.49V179.73C'
  + '242.49 189.66 234.44 197.72 224.5 197.72H92.1C82.17 197.72 74.11 189.66 74.11 179.73V'
  + '76.11C74.11 66.17 82.17 58.12 92.1 58.12H316.61Z';
</script>

<style scoped>
:where(.ui-brand-mark) {
  width: 1em;
  height: 1em;
  flex: none;
}
</style>
