<template>
  <UiButton title="Диф задачи (несохранённые изменения воркдира)" @click="openDiff">
    <span class="ic mono">±</span> Диф
  </UiButton>
</template>

<script setup>
import { useDiffStore } from '../stores/diff.js';
import { UiButton } from '../ui';

// Кнопка задачи: открыть диф (несохранённые изменения воркдира) в большом модале.
// Нижний модал (приёмка/задача) НЕ закрываем — при закрытии дифа пользователь
// возвращается туда, откуда открыл.
const props = defineProps({
  taskId: { type: [String, Number], required: true },
});
const diff = useDiffStore();
function openDiff() { diff.openFor(props.taskId); }
</script>

<style scoped>
.ic { color: var(--node-code); font-weight: 700; }
</style>
