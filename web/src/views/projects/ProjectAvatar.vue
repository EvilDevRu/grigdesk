<template>
  <span class="project-avatar" :class="{ large, 'is-placeholder': !imageSrc && !initial }"
    :style="{ '--project-hue': hue }" aria-hidden="true">
    <img v-if="imageSrc" :src="imageSrc" alt="" data-project-icon-image @error="failed = true" />
    <span v-else-if="initial" data-project-initial>{{ initial }}</span>
    <ProjectIcon v-else name="folder" />
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { projectIcon } from '../../../../shared/runtime/projectIcon.ts';
import ProjectIcon from './ProjectIcon.vue';

const props = defineProps<{
  id?: string;
  title: string;
  icon?: string | null;
  large?: boolean;
}>();
const failed = ref(false);
const source = computed(() => projectIcon(props.icon));
const imageSrc = computed(() => failed.value ? null : source.value);
const initial = computed(() => Array.from(props.title.trim())[0]?.toLocaleUpperCase());
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

.project-avatar.is-placeholder {
  color: var(--ink-mid);
  background: var(--surface-2);
}

.project-avatar.is-placeholder svg {
  width: 55%;
  height: 55%;
}

.large {
  width: 44px;
  height: 44px;
  font-size: 20px;
}
</style>
