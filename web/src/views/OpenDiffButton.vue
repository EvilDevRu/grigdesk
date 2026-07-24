<script setup>
import { useRouter } from 'vue-router';

// Кнопка задачи: открыть диф (несохранённые изменения воркдира — их смотрят на приёмке).
const props = defineProps({
  taskId: { type: [String, Number], required: true },
});
const router = useRouter();
function openDiff() { router.push({ name: 'diff', query: { task: String(props.taskId) } }); }
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
