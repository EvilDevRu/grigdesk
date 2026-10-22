<template>
  <UiIconButton
    role="rail"
    tone="warning"
    :pressed="active"
    :loading="pending"
    :label="label"
    v-tooltip="label"
    @click="emit('toggle')"
  >
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      :fill="active ? 'currentColor' : 'none'"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      focusable="false"
      aria-hidden="true"
    >
      <path d="m12 2.75 2.85 5.78 6.38.93-4.62 4.5 1.09 6.36-5.7-3-5.7 3 1.09-6.36-4.62-4.5 6.38-.93z" />
    </svg>
  </UiIconButton>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { UiIconButton, vTooltip } from '../../ui';

const props = defineProps({
  active: { type: Boolean, default: false },
  pending: { type: Boolean, default: false },
  taskTitle: { type: String, default: '' },
});

const emit = defineEmits<{ toggle: [] }>();

const subject = computed(() => props.taskTitle ? `задачу «${props.taskTitle}»` : 'эту задачу');
const label = computed(() => (
  props.active
    ? `Убрать ${subject.value} из избранного`
    : `Добавить ${subject.value} в избранное`
));
</script>

<style scoped>
svg {
  display: block;
  width: 18px;
  height: 18px;
  flex: none;
  overflow: visible;
}
</style>
