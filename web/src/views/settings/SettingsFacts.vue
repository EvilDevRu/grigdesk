<template>
  <dl class="settings-facts">
    <div v-for="item in items" :key="item.label">
      <dt>{{ item.label }}</dt>
      <dd>{{ item.value }}</dd>
    </div>
  </dl>
</template>

<script setup lang="ts">
defineProps<{ items: readonly { label: string; value: string }[] }>();
</script>

<style scoped>
/* Сведения о состоянии — пары «название — значение» на общей оси, а не строки текста.
   В узкой форме значение переносится под название. */
.settings-facts {
  container: settings-facts / inline-size;
  display: grid;
  gap: 6px;
  width: 100%;
  margin: 0;
}
.settings-facts > div {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 16px;
}
.settings-facts dt {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
}
.settings-facts dd {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
@container settings-facts (max-width: 420px) {
  .settings-facts > div {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
}
</style>
