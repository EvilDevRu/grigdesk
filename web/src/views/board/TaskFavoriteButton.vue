<script setup>
import { computed } from 'vue';

const props = defineProps({
  active: { type: Boolean, default: false },
  pending: { type: Boolean, default: false },
  taskTitle: { type: String, default: '' },
});
const emit = defineEmits(['toggle']);

const subject = computed(() => props.taskTitle ? `задачу «${props.taskTitle}»` : 'эту задачу');
const label = computed(() => (
  props.active
    ? `Убрать ${subject.value} из избранного`
    : `Добавить ${subject.value} в избранное`
));
</script>

<template>
  <button
    type="button"
    class="favbtn"
    :class="{ 'is-favorite': active, 'is-pending': pending }"
    :disabled="pending"
    :aria-pressed="String(active)"
    :aria-busy="pending ? 'true' : undefined"
    :aria-label="label"
    :title="label"
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
  </button>
</template>

<style scoped>
.favbtn {
  width: 32px;
  height: 32px;
  flex: none;
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 999px;
  color: color-mix(in srgb, var(--ink-mid) 68%, transparent);
  background: transparent;
  cursor: pointer;
}
.favbtn svg {
  display: block;
  width: 18px;
  height: 18px;
  flex: none;
  overflow: visible;
}
.favbtn:hover { color: var(--warn); background: color-mix(in srgb, var(--warn) 9%, transparent); }
.favbtn.is-favorite { color: var(--warn); }
.favbtn:focus-visible {
  outline: none;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 9%, transparent);
}
.favbtn:disabled { cursor: wait; opacity: 1; }
.favbtn.is-pending {
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 9%, transparent);
}
</style>
