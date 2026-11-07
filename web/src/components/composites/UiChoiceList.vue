<template>
  <div
    class="ui-choice-list"
    role="listbox"
    :aria-multiselectable="mode === 'multiple' ? 'true' : undefined"
    :aria-label="label"
    :data-selection-indicator="selectionIndicator || undefined"
  >
    <UiPressable
      v-for="option in options"
      :key="String(option.value)"
      class="ui-choice-list__option"
      role="option"
      :disabled="disabled || option.disabled"
      :aria-selected="String(selected(option.value))"
      @click="choose(option.value)"
    >
      <span
        v-if="selectionIndicator"
        class="ui-choice-list__indicator"
        :data-mode="mode"
        aria-hidden="true"
      />
      <span class="ui-choice-list__content">
        <span class="ui-choice-list__label">{{ option.label }}</span>
        <span v-if="option.description" class="ui-choice-list__description">{{
          option.description
        }}</span>
      </span>
    </UiPressable>
    <slot />
  </div>
</template>

<script
  setup
  lang="ts"
  generic="T extends string | number | boolean | object | null"
>
import type { UiChoiceMode, UiSelectionOption } from '../../types/uiSelection';
import UiPressable from '../primitives/UiPressable.vue';

const props = withDefaults(
  defineProps<{
    options?: Array<UiSelectionOption<T>>;
    mode?: UiChoiceMode;
    label?: string;
    disabled?: boolean;
    selectionIndicator?: boolean;
  }>(),
  {
    options: () => [],
    mode: 'single',
    label: undefined,
    disabled: false,
    selectionIndicator: false,
  },
);

defineSlots<{ default?(): unknown }>();

const model = defineModel<T | T[] | null>();

function selected(value: T): boolean {
  return Array.isArray(model.value)
    ? model.value.some((item) => Object.is(item, value))
    : Object.is(model.value, value);
}

/**
 * В одиночном режиме выбор заменяет значение, а в множественном меняет копию массива.
 * Копирование сохраняет реактивность Vue, а Object.is поддерживает объектные значения.
 */
function choose(value: T): void {
  if (props.mode === 'single') {
    model.value = value;

    return;
  }

  const current = Array.isArray(model.value) ? ([...model.value] as T[]) : [];
  const index = current.findIndex((item) => Object.is(item, value));

  if (index >= 0) {
    current.splice(index, 1);
  } else {
    current.push(value);
  }

  model.value = current;
}
</script>
