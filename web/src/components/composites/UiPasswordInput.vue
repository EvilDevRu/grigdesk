<template>
  <div class="ui-input-composite ui-password-input">
    <UiInput
      ref="input"
      v-bind="$attrs"
      v-model="model"
      :type="visible ? 'text' : 'password'"
      :disabled="disabled"
      :readonly="readonly"
      :invalid="invalid"
      @input="$emit('input', $event)"
      @change="$emit('change', $event)"
    />
    <UiIconButton
      role="embedded"
      :label="visible ? (hideLabel ?? t('core.hidePassword')) : (showLabel ?? t('core.showPassword'))"
      :disabled="disabled"
      @click="visible = !visible"
    >
      {{ visible ? '🙈' : '👁' }}
    </UiIconButton>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../services/locale.ts';

import { ref } from 'vue';
import UiIconButton from '../primitives/UiIconButton.vue';
import UiInput from '../primitives/UiInput.vue';

defineOptions({ inheritAttrs: false });
withDefaults(
  defineProps<{
    disabled?: boolean;
    readonly?: boolean;
    invalid?: boolean;
    showLabel?: string;
    hideLabel?: string;
  }>(),
  {
    disabled: false,
    readonly: false,
    invalid: false,
    showLabel: undefined,
    hideLabel: undefined,
  },
);
defineEmits<{
  input: [event: Event];
  change: [event: Event];
}>();

const model = defineModel<string>({ default: '' });
const visible = ref(false);
const input = ref<InstanceType<typeof UiInput> | null>(null);

defineExpose({
  get el() {
    return input.value?.el ?? null;
  },
  focus: (options?: FocusOptions) => input.value?.focus(options),
  select: () => input.value?.select(),
});
</script>
