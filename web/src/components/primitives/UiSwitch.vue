<template>
  <label
    class="ui-switch"
    :class="{ 'is-disabled': disabled, 'is-checked': Boolean(model) }"
  >
    <input
      ref="element"
      v-bind="$attrs"
      class="ui-switch__native"
      type="checkbox"
      role="switch"
      :checked="Boolean(model)"
      :disabled="disabled"
      :aria-disabled="ariaDisabled || undefined"
      :aria-checked="Boolean(model)"
      @change="onChange"
    />
    <span class="ui-switch__track" aria-hidden="true"
      ><span class="ui-switch__thumb"
    /></span>
    <span v-if="$slots.default" class="ui-switch__label"><slot /></span>
  </label>
</template>

<script setup lang="ts">
import { ref } from 'vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    ariaDisabled?: boolean;
  }>(),
  { disabled: false, ariaDisabled: false },
);

defineSlots<{ default?(): unknown }>();

const emit = defineEmits<{ change: [event: Event] }>();
const model = defineModel<boolean>({ default: false });
const element = ref<HTMLInputElement | null>(null);

/**
 * В режиме `ariaDisabled` нативный checkbox не заблокирован и может переключиться сам.
 * Возвращаем прежнее состояние до любых emit, иначе DOM разойдётся с моделью.
 */
function onChange(event: Event): void {
  const input = event.target as HTMLInputElement;

  if (props.ariaDisabled) {
    input.checked = Boolean(model.value);
    event.preventDefault();

    return;
  }

  emit('change', event);
  model.value = input.checked;
}

defineExpose({
  get el() {
    return element.value;
  },
  focus: (options?: FocusOptions) => element.value?.focus(options),
});
</script>
