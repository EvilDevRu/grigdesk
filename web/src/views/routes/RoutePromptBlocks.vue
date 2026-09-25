<template>
  <ol class="route-prompt-blocks">
    <li v-for="(block, index) in blocks" :key="`${block.file}:${index}`">
      <UiButton class="route-prompt-blocks__select" :aria-pressed="selected === index"
                @click="$emit('select', index)">
        {{ block.file }}
      </UiButton>
      <UiButton :data-test="`move-up-${index}`" :disabled="index === 0"
                @click="$emit('move', { from: index, to: index - 1 })">↑</UiButton>
      <UiButton :data-test="`move-down-${index}`" :disabled="index === blocks.length - 1"
                @click="$emit('move', { from: index, to: index + 1 })">↓</UiButton>
    </li>
  </ol>
</template>

<script setup lang="ts">
import type { RoutePromptBlock } from '../../../../shared/routeDefinition.ts';
import { UiButton } from '../../ui';

defineProps<{ blocks: RoutePromptBlock[]; selected: number }>();
defineEmits<{
  select: [index: number];
  move: [value: { from: number; to: number }];
}>();
</script>

<style scoped>
.route-prompt-blocks { padding-left: 22px; }
.route-prompt-blocks li { display: flex; align-items: center; gap: 5px; margin: 5px 0; }
.route-prompt-blocks__select { flex: 1; min-width: 0; text-align: left; }
</style>
