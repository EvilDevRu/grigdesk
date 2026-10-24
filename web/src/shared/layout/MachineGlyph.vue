<template>
  <svg class="machine-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name]" />
  </svg>
</template>

<script setup lang="ts">
defineProps<{ name: keyof typeof paths }>();

const paths = {
  machine: 'M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z M8 20h8m-4-4v4',
  lock: 'M7 10h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z'
    + ' M8 10V7a4 4 0 0 1 8 0v3m-4 5v2',
  back: 'M19 12H5m6-6-6 6 6 6',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  scan: 'M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3M3 12h18',
  qr: 'M3 3h6v6H3ZM15 3h6v6h-6ZM3 15h6v6H3ZM15 15h3v3h3v3h-3m-3 0v-3M12 3v6m-9 3h6m3 0h3v-1m3 1h3M12 15v3',
  paste: 'M9 5H6a2 2 0 0 0-2 2v13h13v-3M15 5h2a2 2 0 0 1 2 2v3M9 3h6v4H9ZM13 14h8m-3-3 3 3-3 3',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 12.1 1L20 12M4 12l1.8 4.9a8 8 0 0 0 12.1 1',
  offline: 'm3 3 18 18M9 9a11 11 0 0 1 10 3M5 12a11 11 0 0 1 1.5-1M3 7a16 16 0 0 1 2-.9'
    + 'M9 5a16 16 0 0 1 12 2m-9 13h.01M9 16a5 5 0 0 1 4-.9',
  edit: 'm15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-4-4L5 15l-1 5Z',
  disconnect: 'M12 3v9M7 5.5a8 8 0 1 0 10 0',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
};
</script>

<style scoped>
.machine-glyph {
  flex: none;
  width: 20px;
  height: 20px;
}
</style>
