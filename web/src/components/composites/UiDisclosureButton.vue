<template>
  <UiButton
    v-bind="$attrs"
    class="ui-disclosure-button"
    :class="`ui-disclosure-button--${density}`"
    :data-density="density"
    :variant="variant"
    :tone="tone"
    :disabled="disabled"
    :aria-expanded="String(open)"
    :aria-controls="controls"
    @click="toggle"
  >
    <slot />
    <template #trailing>
      <svg
        class="ui-disclosure-button__chevron"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <path d="m6 4 4 4-4 4" />
      </svg>
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
    density?: 'default' | 'compact';
    variant?: UiActionVariant;
    tone?: UiActionTone;
  }>(),
  {
    open: false,
    disabled: false,
    density: 'default',
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
