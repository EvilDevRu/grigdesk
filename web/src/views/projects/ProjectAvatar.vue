<template>
  <span class="project-avatar" :class="{ large }" :style="{ '--project-hue': hue }" aria-hidden="true">
    <img v-if="source && !failed" :src="source" alt="" data-project-icon-image @error="failed = true" />
    <span v-else data-project-initial>{{ initial }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { projectIcon } from '../../../../shared/runtime/projectIcon.ts';

const props = defineProps<{
  id?: string;
  title: string;
  icon?: string | null;
  large?: boolean;
}>();
const failed = ref(false);
const source = computed(() => projectIcon(props.icon));
const initial = computed(() => Array.from(props.title.trim())[0]?.toLocaleUpperCase() || '?');
const hue = computed(() => Array.from(props.id || props.title).reduce(
  (hash, char) => (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0, 0,
) % 360);

watch(source, () => {
  failed.value = false;
});
</script>

<style scoped>
.project-avatar {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  overflow: hidden;
  border-radius: var(--control-radius);
  color: hsl(var(--project-hue) 65% 72%);
  background: hsl(var(--project-hue) 35% 23%);
  font-weight: 600;
}
.project-avatar img { width: 100%; height: 100%; object-fit: contain; }
.large { width: 52px; height: 52px; font-size: 23px; }
</style>
