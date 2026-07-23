<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../shared/api-client.js';

// Кнопка «Открыть в VS Code на воркдире задачи». Берёт BE_WT/FE_WT задачи и ведёт в раздел «Код».
const props = defineProps({
  taskId: { type: [String, Number], required: true },
  label: { type: String, default: 'VS Code' },
});
const router = useRouter();
const loading = ref(false);
const err = ref('');

async function open() {
  loading.value = true; err.value = '';
  try {
    const ws = await api.get(`/api/tasks/${props.taskId}/workspace`);
    const folder = ws.beWt || ws.feWt;
    if (!folder) { err.value = 'нет воркдира'; return; }
    router.push({ name: 'code', query: { folder } });
  } catch (e) { err.value = e.message; }
  finally { loading.value = false; }
}
</script>

<template>
  <button class="oc" :disabled="loading" :title="err || 'Открыть код задачи в VS Code'" @click="open">
    <span v-if="loading" class="spin"></span>
    <span v-else class="ic mono">&lt;/&gt;</span>
    {{ err || label }}
  </button>
</template>

<style scoped>
.oc { display: inline-flex; align-items: center; gap: 7px; background: var(--surface-2); border: 1px solid var(--line);
  color: var(--ink); border-radius: 8px; padding: 6px 12px; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.oc:hover:not(:disabled) { border-color: var(--line-2); }
.oc:disabled { opacity: .6; cursor: default; }
.ic { color: var(--node-code); font-weight: 700; }
</style>
