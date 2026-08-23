<template>
  <UiButton
    v-bind="$attrs"
    :pressed="model"
    :disabled="disabled"
    :aria-disabled="ariaDisabled"
    :variant="variant"
    :tone="tone"
    @click="toggle"
    ><slot
  /></UiButton>
</template>

<script setup lang="ts">
import type { UiActionTone, UiActionVariant } from '../../types/uiActions';
import UiButton from '../primitives/UiButton.vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    ariaDisabled?: boolean;
    variant?: UiActionVariant;
    tone?: UiActionTone;
  }>(),
  {
    disabled: false,
    ariaDisabled: false,
    variant: 'ghost',
    tone: 'neutral',
  },
);

defineSlots<{ default(): unknown }>();

const emit = defineEmits<{ click: [event: MouseEvent] }>();
const model = defineModel<boolean>({ default: false });

function toggle(event: MouseEvent): void {
  model.value = !model.value;
  emit('click', event);
}
</script>
