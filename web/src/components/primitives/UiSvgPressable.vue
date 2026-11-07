<template>
  <g
    ref="element"
    v-bind="$attrs"
    class="ui-svg-pressable"
    role="button"
    :tabindex="disabled ? -1 : 0"
    :aria-disabled="guarded || undefined"
    :aria-busy="loading || undefined"
    :aria-pressed="pressed"
    @click="activate"
    @keydown="onKeydown"
    ><slot
  /></g>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    ariaDisabled?: boolean;
    loading?: boolean;
    pressed?: boolean;
  }>(),
  {
    disabled: false,
    ariaDisabled: false,
    loading: false,
    pressed: undefined,
  },
);

defineSlots<{ default(): unknown }>();

const emit = defineEmits<{ click: [event: MouseEvent | KeyboardEvent] }>();
const element = ref<SVGGElement | null>(null);
const guarded = computed(
  () => props.disabled || props.ariaDisabled || props.loading,
);

function activate(event: MouseEvent | KeyboardEvent): void {
  if (guarded.value) {
    event.preventDefault();

    return;
  }

  emit('click', event);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }

  event.preventDefault();
  activate(event);
}

defineExpose({
  get el() {
    return element.value;
  },
  focus: (options?: FocusOptions) => element.value?.focus(options),
});
</script>
