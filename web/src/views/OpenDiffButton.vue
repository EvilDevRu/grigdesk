<script setup>
import { useDiffStore } from '../stores/diff.js';
import { useUiStore } from '../stores/ui.js';

// Кнопка задачи: открыть диф (несохранённые изменения воркдира) в большом модале.
const props = defineProps({
  taskId: { type: [String, Number], required: true },
});
const diff = useDiffStore();
const ui = useUiStore();
// Закрываем модалку задачи, чтобы не было стекинга оверлеев (их blur мерцает под Monaco).
function openDiff() { ui.close(); diff.openFor(props.taskId); }
</script>

<template>
  <button class="oc" title="Диф задачи (несохранённые изменения воркдира)" @click="openDiff">
    <span class="ic mono">±</span> Диф
  </button>
</template>

<style scoped>
.oc { display: inline-flex; align-items: center; gap: 6px; background: var(--surface-2); border: 1px solid var(--line);
  color: var(--ink); border-radius: 8px; padding: 6px 12px; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.oc:hover { border-color: var(--line-2); }
.ic { color: var(--node-code); font-weight: 700; }
</style>
