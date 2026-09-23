<template>
  <span class="project-avatar" :class="{ large }" aria-hidden="true">{{ initial }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  title: string;
  large?: boolean;
}>();

const initial = computed(() => props.title.trim().slice(0, 1).toLocaleUpperCase('ru') || '+');
</script>

<style scoped>
.project-avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--line-2);
  border-radius: 10px;
  background: linear-gradient(145deg, var(--surface-2), var(--surface));
  color: var(--ink-mid);
  font-size: 15px;
  font-weight: 600;
}

.large {
  width: 52px;
  height: 52px;
  border-color: color-mix(in srgb, var(--accent) 30%, var(--line));
  border-radius: 15px;
  background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 12%, var(--surface)), var(--surface));
  color: var(--accent);
  font-size: 23px;
}
</style>
