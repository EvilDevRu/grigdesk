<script setup>
// Переключатель проектов (профилей) + создание нового. Никаких зашитых имён:
// список приходит с сервера (/api/profiles), выбор — через v-model.
import { ref } from 'vue';
import { api } from '../api-client.js';
import { alertDialog } from './confirm.js';

defineProps({
  profiles: { type: Array, required: true },
  modelValue: { type: String, required: true },
});
const emit = defineEmits(['update:modelValue', 'created']);
const creating = ref(false);

async function addProject() {
  const id = (prompt('id нового проекта (строчные латиница/цифры/-/_):') || '').trim();
  if (!id) return;
  creating.value = true;
  try {
    const res = await api.post('/api/profiles', { id });
    emit('created', { id, profiles: res.profiles || [] });
  } catch (e) { alertDialog(`Не удалось создать проект: ${e.message}`); }
  finally { creating.value = false; }
}
</script>

<template>
  <div class="projrow">
    <button v-for="p in profiles" :key="p" class="pchip mono" :class="{ on: p === modelValue }"
            @click="emit('update:modelValue', p)">{{ p }}</button>
    <button class="pchip padd" :disabled="creating" title="Новый проект" @click="addProject">
      <span v-if="creating" class="spin"></span><span v-else>+</span>
    </button>
  </div>
</template>

<style scoped>
.projrow { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 4px 10px; }
.pchip { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid);
  border-radius: 999px; padding: 3px 12px; font-size: 12px; cursor: pointer; }
.pchip:hover { border-color: var(--line-2); color: var(--ink); }
.pchip.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, var(--line));
  background: color-mix(in srgb, var(--accent) 12%, transparent); }
.padd { padding: 3px 10px; font-weight: 700; }
</style>
