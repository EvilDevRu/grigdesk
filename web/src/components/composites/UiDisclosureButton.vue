<template>
  <UiButton
    v-bind="$attrs"
    class="ui-disclosure-button"
    :variant="variant"
    :tone="tone"
    :disabled="disabled"
    :aria-expanded="String(open)"
    :aria-controls="controls"
    @click="toggle"
  >
    <slot />
    <template #trailing>
      <span class="ui-disclosure-button__chevron" aria-hidden="true">›</span>
    </template>
  </UiButton>
</template>

<script setup lang="ts">
import type { UiActionTone, UiActionVariant } from '../../types/uiActions';
import UiButton from '../primitives/UiButton.vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    open?: boolean;
    controls: string;
    disabled?: boolean;
    variant?: UiActionVariant;
    tone?: UiActionTone;
  }>(),
  {
    open: false,
    disabled: false,
    variant: 'ghost',
    tone: 'neutral',
  },
);

defineSlots<{ default(): unknown }>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  click: [event: MouseEvent];
}>();

function toggle(event: MouseEvent): void {
  emit('update:open', !props.open);
  emit('click', event);
}
</script>
