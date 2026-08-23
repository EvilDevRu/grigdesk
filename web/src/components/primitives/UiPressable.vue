<template>
  <button
    ref="element"
    v-bind="$attrs"
    class="ui-pressable"
    :type="type"
    :disabled="disabled"
    :aria-disabled="guarded || undefined"
    :aria-busy="loading || undefined"
    :aria-pressed="pressed"
    @click="onClick"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { UiButtonType } from '../../types/uiActions';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    type?: UiButtonType;
    disabled?: boolean;
    ariaDisabled?: boolean;
    loading?: boolean;
    pressed?: boolean;
  }>(),
  {
    type: 'button',
    disabled: false,
    ariaDisabled: false,
    loading: false,
    pressed: undefined,
  },
);

defineSlots<{ default(): unknown }>();

const emit = defineEmits<{ click: [event: MouseEvent] }>();
const element = ref<HTMLButtonElement | null>(null);
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
