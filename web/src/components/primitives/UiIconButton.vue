<template>
  <UiButton
    v-bind="$attrs"
    class="ui-icon-button"
    :class="`ui-icon-button--${normalizedRole}`"
    :data-role="normalizedRole"
    :type="type"
    :variant="variant"
    :tone="tone"
    :loading="loading"
    :loading-label="loadingLabel || label"
    :disabled="disabled"
    :aria-disabled="ariaDisabled"
    :pressed="pressed"
    :aria-label="label"
    @click="$emit('click', $event)"
    ><slot
  /></UiButton>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type {
  UiActionTone,
  UiActionVariant,
  UiButtonType,
  UiIconRole,
} from '../../types/uiActions';
import UiButton from './UiButton.vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    label: string;
    role?: UiIconRole;
    type?: UiButtonType;
    variant?: UiActionVariant;
    tone?: UiActionTone;
    loading?: boolean;
    loadingLabel?: string;
    disabled?: boolean;
    ariaDisabled?: boolean;
    pressed?: boolean;
  }>(),
  {
    role: 'peer',
    type: 'button',
    variant: 'ghost',
    tone: 'neutral',
    loading: false,
    loadingLabel: undefined,
    disabled: false,
    ariaDisabled: false,
    pressed: undefined,
  },
);

defineSlots<{ default(): unknown }>();
defineEmits<{ click: [event: MouseEvent] }>();

const normalizedRole = computed<UiIconRole>(() =>
  ['peer', 'embedded', 'rail', 'stepper'].includes(props.role)
    ? props.role
    : 'peer',
);
</script>
