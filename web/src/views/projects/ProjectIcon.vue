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
  chatList: 'M4 6h2m4 0h10M4 12h2m4 0h10M4 18h2m4 0h10',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  sort: 'M7 4v16m-4-4 4 4 4-4M14 6h7M14 11h5M14 16h3',
  more: 'M5 12h.1M12 12h.1M19 12h.1',
  up: 'm6 14 6-6 6 6',
  down: 'm6 10 6 6 6-6',
  upload: 'M12 16V4m-4 4 4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7',
  remove: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  back: 'm10 5-7 7 7 7M3 12h18',
  archive: 'M4 4h16v5H4ZM6 9v11h12V9M10 13h4',
  repo: 'M5 4h14v16H7a2 2 0 0 1-2-2Zm0 12h14M9 8h6M9 11h6',
  git: 'M12 2 22 12 12 22 2 12Z M8 6l2 2m2 2 2 2M11 10v4'
    + ' M12 9a1 1 0 1 0-2 0 1 1 0 1 0 2 0Z M16 13a1 1 0 1 0-2 0 1 1 0 1 0 2 0Z'
    + ' M12 15a1 1 0 1 0-2 0 1 1 0 1 0 2 0Z',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
};
</script>
