<template>
  <div
    class="ui-progress"
    :class="[`ui-progress--${normalizedTone}`, { 'ui-progress--line': size === 'line' }]"
    role="progressbar"
    :aria-label="label"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="indeterminate ? undefined : clamped"
    :aria-valuetext="valueText"
  >
    <span
      class="ui-progress__bar"
      :class="{ 'is-indeterminate': indeterminate }"
      :style="barStyle"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UiActionTone } from '../../types/uiActions';
import { normalizeActionTone } from '../../types/uiActions';

const props = withDefaults(
  defineProps<{
    value?: number;
    min?: number;
    max?: number;
    label: string;
    valueText?: string;
    indeterminate?: boolean;
    tone?: UiActionTone;
    // line — тонкая линия во всю ширину под шапкой окна или панели, без скругления.
    size?: 'default' | 'line';
  }>(),
  {
    value: 0,
    min: 0,
    max: 100,
    valueText: undefined,
    indeterminate: false,
    tone: 'accent',
    size: 'default',
  },
);

const normalizedTone = computed(() => normalizeActionTone(props.tone));
const clamped = computed(() =>
  Math.min(props.max, Math.max(props.min, props.value)),
);
const percentage = computed(() =>
  props.max === props.min
    ? 0
    : ((clamped.value - props.min) / (props.max - props.min)) * 100,
);
const barStyle = computed(() =>
  props.indeterminate ? undefined : { width: `${percentage.value}%` },
);
</script>
