<template>
  <div class="settings-empty">
    <strong>{{ heading }}</strong>
    <p v-if="text">{{ text }}</p>
  </div>
</template>

<script setup lang="ts">
defineProps<{ heading: string; text?: string }>();
</script>

<style scoped>
/* Пустое состояние одного вида на всех страницах: название и пояснение без рамки,
   чтобы оно не выглядело ни разделом, ни отдельной карточкой. */
.settings-empty {
  display: grid;
  justify-items: start;
  gap: 4px;
  padding: 12px 0;
}
.settings-empty strong {
  color: var(--ink);
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}
.settings-empty p {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 16px;
}
</style>
