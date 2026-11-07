<template>
  <UiButton v-tooltip="'Диф задачи (несохранённые изменения воркдира)'" @click="openDiff">
    <span class="ic mono">±</span> Диф
  </UiButton>
</template>

<script setup lang="ts">
import { useDiffStore } from '../stores/diff.ts';
import { UiButton, vTooltip } from '../ui';

// Кнопка задачи: открыть диф (несохранённые изменения воркдира) в большом модале.
// Нижний модал (приёмка/задача) НЕ закрываем — при закрытии дифа пользователь
// возвращается туда, откуда открыл.
const props = defineProps({
  taskId: { type: [String, Number], required: true },
});

const diff = useDiffStore();

function openDiff() {
  diff.openFor(props.taskId);
}
</script>

<style scoped>
.ic { color: var(--node-code); font-weight: 700; }
</style>
