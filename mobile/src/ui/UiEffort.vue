<template>
  <label class="chat-effort" data-touch-density="compact">
    <span class="chat-control-label">Эффорт</span>
    <input
      type="range"
      class="chat-effort-range"
      min="0"
      :max="levels.length"
      step="1"
      :value="index"
      :disabled="disabled || !levels.length"
      aria-label="Усилие модели"
      :aria-valuetext="caption"
      :style="{ '--effort-progress': `${index / (levels.length || 1) * 100}%` }"
      @input="index = Number(($event.target as HTMLInputElement).value)"
      @change="$emit('change', index ? levels[index - 1]! : '')"
    />
    <span class="chat-effort-value">{{ caption }}</span>
  </label>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  value: string;
  levels: string[];
  disabled?: boolean;
}>();

defineEmits<{ change: [value: string] }>();

const index = ref(0);
const caption = computed(() => index.value ? props.levels[index.value - 1] : 'Авто');

watch(() => [props.value, props.levels], () => {
  index.value = Math.max(0, props.levels.indexOf(props.value) + 1);
}, { immediate: true });
</script>
