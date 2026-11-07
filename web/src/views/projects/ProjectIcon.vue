<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name]" />
  </svg>
</template>
<script setup lang="ts">
defineProps<{ name: keyof typeof paths }>();

const paths = {
  plus: 'M12 5v14M5 12h14',
  chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z M7 9h10M7 13h7',
  sort: 'M7 4v16m-4-4 4 4 4-4M14 6h7M14 11h5M14 16h3',
  more: 'M5 12h.1M12 12h.1M19 12h.1',
  up: 'm6 14 6-6 6 6',
  down: 'm6 10 6 6 6-6',
  remove: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  back: 'm10 5-7 7 7 7M3 12h18',
  archive: 'M4 4h16v5H4ZM6 9v11h12V9M10 13h4',
  repo: 'M5 4h14v16H7a2 2 0 0 1-2-2Zm0 12h14M9 8h6M9 11h6',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
};
</script>
