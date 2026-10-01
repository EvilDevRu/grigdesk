<template>
  <div class="ui-discrete-slider" :class="{ 'ui-discrete-slider--ticks': ticks }">
    <UiRange
      v-model="model"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :aria-disabled="readonly"
      :aria-value-text="valueLabel"
      :aria-label="label"
    />
    <div
      v-if="points.length"
      class="ui-discrete-slider__points"
      aria-hidden="true"
    >
      <span
        v-for="point in points"
        :key="point.value"
        :class="{ 'is-active': point.value === model }"
        >{{ point.label }}</span
      >
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import UiRange from '../primitives/UiRange.vue';

const props = withDefaults(
  defineProps<{
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    readonly?: boolean;
    ticks?: boolean;
    label?: string;
    labels?: Record<number, string>;
  }>(),
  {
    min: 0,
    max: 100,
    step: 1,
    disabled: false,
    readonly: false,
    ticks: false,
    label: undefined,
    labels: () => ({}),
  },
);
const model = defineModel<number>({ required: true });
const points = computed(() =>
  Object.entries(props.labels).map(([value, label]) => ({
    value: Number(value),
    label,
  })),
);
const valueLabel = computed(
  () => props.labels[model.value] || String(model.value),
);
</script>
