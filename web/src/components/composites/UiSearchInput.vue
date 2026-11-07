<template>
  <div class="ui-input-composite ui-search-input" :data-size="normalizedSize">
    <UiInput
      ref="input"
      v-bind="$attrs"
      type="search"
      v-model="model"
      :disabled="disabled"
      :readonly="readonly"
      :invalid="invalid"
      @input="$emit('input', $event)"
      @change="$emit('change', $event)"
    />
    <UiIconButton
      v-if="model"
      role="embedded"
      :label="(clearLabel ?? t('core.clearSearch'))"
      :disabled="disabled || readonly"
      @click="clear"
    >
      ×
    </UiIconButton>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../services/locale.ts';

import { computed, nextTick, ref } from 'vue';
import { normalizeActionSize, type UiActionSize } from '../../types/uiActions';
import UiIconButton from '../primitives/UiIconButton.vue';
import UiInput from '../primitives/UiInput.vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    readonly?: boolean;
    invalid?: boolean;
    clearLabel?: string;
    size?: UiActionSize;
  }>(),
  {
    disabled: false,
    readonly: false,
    invalid: false,
    clearLabel: undefined,
    size: 'default',
  },
);
const emit = defineEmits<{
  clear: [];
  input: [event: Event];
  change: [event: Event];
}>();
const model = defineModel<string>({ default: '' });
const input = ref<InstanceType<typeof UiInput> | null>(null);
const normalizedSize = computed(() => normalizeActionSize(props.size));

/**
 * После очистки кнопка исчезает из DOM, поэтому фокус возвращается полю
 * только на следующем тике и не теряется вместе с удалённой кнопкой.
 */
async function clear(): Promise<void> {
  model.value = '';
  emit('clear');
  await nextTick();
  input.value?.focus();
}

defineExpose({
  get el() {
    return input.value?.el ?? null;
  },
  focus: (options?: FocusOptions) => input.value?.focus(options),
  select: () => input.value?.select(),
  clear,
});
</script>
