<template>
  <div class="ui-discrete-slider" :class="{
    'ui-discrete-slider--ticks': ticks,
    'ui-discrete-slider--thin': thin,
    'ui-discrete-slider--unselected': unselected,
  }" :style="thin ? trackStyle : undefined">
    <UiRange
      v-model="rangeValue"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :aria-disabled="readonly"
      :aria-value-text="valueText || valueLabel"
      :aria-label="label"
      @pointerdown="beginPointer"
      @pointerup="finishPointer"
      @pointercancel="pointerStarted = false"
      @keydown="selectBoundary"
    />
    <div
      v-if="points.length"
      class="ui-discrete-slider__points"
      aria-hidden="true"
    >
      <span
        v-for="point in points"
        :key="point.value"
        :class="{ 'is-active': !unselected && point.value === model }"
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
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    readonly?: boolean;
    unselected?: boolean;
    ticks?: boolean;
    thin?: boolean;
    label?: string;
    valueText?: string;
    labels?: Record<number, string>;
  }>(),
  {
    min: 0,
    max: 100,
    step: 1,
    disabled: false,
    readonly: false,
    unselected: false,
    ticks: false,
    thin: false,
    label: undefined,
    valueText: undefined,
    labels: () => ({}),
  },
);
const emit = defineEmits<{ 'update:modelValue': [value: number] }>();

let pointerStarted = false;
let pointerChanged = false;

const model = computed({
  get: () => props.modelValue,
  set: (value: number) => emit('update:modelValue', value),
});

const rangeValue = computed({
  get: () => model.value,
  set: (value: number) => {
    if (!props.disabled && !props.readonly) {
      pointerChanged = true;

      model.value = value;
    }
  },
});

/**
 * Запоминаем жест из пустого выбора: на физическом min браузер может не дать input.
 * Обычный input уже подтверждает выбор и исключает повторное событие на pointerup.
 */
function beginPointer(): void {
  pointerStarted = props.unselected && !props.disabled && !props.readonly;
  pointerChanged = false;
}

/**
 * Тап по уже стоящему min тоже является явным выбором первой ступени.
 * Отменённый жест и недоступный control не меняют значение.
 */
function finishPointer(event: PointerEvent): void {
  const shouldSelect = pointerStarted && !pointerChanged && !props.disabled && !props.readonly;

  pointerStarted = false;

  if (shouldSelect) {
    rangeValue.value = (event.target as HTMLInputElement).valueAsNumber;
  }
}

/**
 * Home и End подтверждают крайние значения даже при неизменном native range.
 * Предотвращаем native input, чтобы одно нажатие давало ровно один выбор.
 */
function selectBoundary(event: KeyboardEvent): void {
  if (!props.unselected || props.disabled || props.readonly
    || (event.key !== 'Home' && event.key !== 'End')) {
    return;
  }

  event.preventDefault();
  pointerChanged = true;
  rangeValue.value = event.key === 'Home' ? props.min : props.max;
}

const points = computed(() =>
  Object.entries(props.labels).map(([value, label]) => ({
    value: Number(value),
    label,
  })),
);
const valueLabel = computed(
  () => props.labels[model.value] || String(model.value),
);

// Тонкий трек использует тот же диапазон, что и нативный range, без своей шкалы.
// При пустом выборе заливка отсутствует: физический min ещё не является выбором.
const trackStyle = computed(() => {
  const span = props.max - props.min;
  const filled = props.unselected || span <= 0
    ? 0
    : Math.min(100, Math.max(0, ((model.value - props.min) / span) * 100));

  return { '--ui-slider-fill': `${filled}%` };
});
</script>
