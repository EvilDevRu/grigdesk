<template>
  <svg class="ui-brand-mark" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
    <path class="arc" :d="ARC" />
    <path class="needle" :d="NEEDLE" />
  </svg>
</template>

<script setup lang="ts">
// Знак Кокпита «Шкала C» — тот же облегчённый срез, что у web/src/shared/CockpitMark.vue.
// Пути печатает web/scripts/gen-icons.py: геометрию менять только там и копировать сюда.
const ARC = 'M202.31 42.24A106 106 0 1 0 202.31 213.76L177.62 179.78A64 64 0 1 1 177.62 76.22Z';
const NEEDLE = 'M109 128A31 31 0 1 0 171 128A31 31 0 1 0 109 128Z'
  + 'M146.24 151.29L226.93 104.71L133.76 104.71Z';
</script>

<style scoped>
/* Дуга берёт цвет текста, стрелка — синий акцент, как у знака в рейке Кокпита. */
.arc {
  fill: currentColor;
}

.needle {
  fill: var(--accent);
}
</style>
