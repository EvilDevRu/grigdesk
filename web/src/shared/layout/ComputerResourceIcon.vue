<template>
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
       stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true" focusable="false">
    <path :d="paths[name]" />
  </svg>
</template>

<script setup lang="ts">
defineProps<{ name: keyof typeof paths }>();

// Контур и толщина совпадают со значками оболочки; подпись всегда остаётся рядом.
// Значки декоративные: состояние диска также передают его числа и цвет строки.
const paths = {
  cpu: 'M6 6h12v12H6ZM9 9h6v6H9ZM9 3v3m6-3v3M9 18v3m6-3v3'
    + 'M3 9h3m-3 6h3m12-6h3m-3 6h3',
  memory: 'M3 7h18v10H3ZM7 10v4m5-4v4m5-4v4M6 17v3m4-3v3m4-3v3m4-3v3',
  disk: 'M6 4h12l3 10v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5L6 4ZM3 14h18m-5 3h2',
  warning: 'm10.3 4-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z'
    + 'M12 9v4m0 4h.01',
};
</script>
