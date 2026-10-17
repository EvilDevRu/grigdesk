<template>
  <svg class="cockpit-mark" :class="{ mono }" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
    <path class="arc" :d="ARC" />
    <path class="needle" :d="NEEDLE" />
  </svg>
</template>

<script setup lang="ts">
// Знак Кокпита «Шкала C»: дуга буквы C и стрелка прибора. Здесь облегчённый срез для размеров
// до 32 px; пути печатает web/scripts/gen-icons.py — менять геометрию только там.
defineProps({
  // Одноцветный знак: стрелка берёт цвет дуги (например, цвет статуса у плитки версии).
  mono: { type: Boolean, default: false },
});

const ARC = 'M202.31 42.24A106 106 0 1 0 202.31 213.76L177.62 179.78A64 64 0 1 1 177.62 76.22Z';
const NEEDLE = 'M109 128A31 31 0 1 0 171 128A31 31 0 1 0 109 128Z'
  + 'M146.24 151.29L226.93 104.71L133.76 104.71Z';
</script>

<style scoped>
/* Размер по умолчанию — font-size родителя, как у текстового глифа, который знак заменил.
   :where обнуляет вес селектора: явный размер от родителя (класс на знаке) всегда главнее. */
:where(.cockpit-mark) {
  width: 1em;
  height: 1em;
  flex: none;
}

.arc {
  fill: currentColor;
}

.needle {
  fill: var(--accent);
}

.mono .needle {
  fill: currentColor;
}
</style>
