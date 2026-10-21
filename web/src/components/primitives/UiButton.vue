<template>
  <button
    ref="element"
    v-bind="$attrs"
    class="ui-button"
    :class="[
      `ui-button--${normalizedVariant}`,
      `ui-button--${normalizedTone}`,
      {
        'ui-button--block': block,
        'is-loading': loading,
        'is-pressed': pressed,
      },
    ]"
    :data-variant="normalizedVariant"
    :data-tone="normalizedTone"
    :type="type"
    :disabled="disabled"
    :aria-disabled="guarded || undefined"
    :aria-busy="loading || undefined"
    :aria-pressed="pressed"
    @click="onClick"
  >
    <span
      class="ui-button__content"
      :aria-hidden="loading ? 'true' : undefined"
    >
      <span v-if="$slots.leading" class="ui-button__leading"
        ><slot name="leading"
      /></span>
      <span class="ui-button__label"><slot /></span>
      <span v-if="$slots.trailing" class="ui-button__trailing"
        ><slot name="trailing"
      /></span>
    </span>
    <span v-if="loading" class="ui-button__loading">
      <UiSpinner decorative />
      <span class="ui-visually-hidden">{{ (loadingLabel ?? t('core.loading')) }}</span>
    </span>
  </button>
</template>

<script setup lang="ts">
import { t } from '../../services/locale.ts';

import { computed, ref } from 'vue';
import type {
  UiActionTone,
  UiActionVariant,
  UiButtonType,
} from '../../types/uiActions';
import {
  normalizeActionTone,
  normalizeActionVariant,
} from '../../types/uiActions';
import UiSpinner from './UiSpinner.vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    type?: UiButtonType;
    variant?: UiActionVariant;
    tone?: UiActionTone;
    loading?: boolean;
    loadingLabel?: string;
    disabled?: boolean;
    ariaDisabled?: boolean;
    pressed?: boolean;
    block?: boolean;
  }>(),
  {
    type: 'button',
    variant: 'outline',
    tone: 'neutral',
    loading: false,
    loadingLabel: undefined,
    disabled: false,
    ariaDisabled: false,
    pressed: undefined,
    block: false,
  },
);

defineSlots<{
  default(): unknown;
  leading?(): unknown;
  trailing?(): unknown;
}>();

const emit = defineEmits<{ click: [event: MouseEvent] }>();
const element = ref<HTMLButtonElement | null>(null);
const normalizedVariant = computed(() => normalizeActionVariant(props.variant));
const normalizedTone = computed(() => normalizeActionTone(props.tone));
const guarded = computed(() => props.loading || props.ariaDisabled);

function onClick(event: MouseEvent): void {
  if (props.disabled || guarded.value) {
    event.preventDefault();
    event.stopImmediatePropagation();

    return;
  }

  emit('click', event);
}

defineExpose({
  get el() {
    return element.value;
  },
  focus: (options?: FocusOptions) => element.value?.focus(options),
  click: () => element.value?.click(),
});
</script>
