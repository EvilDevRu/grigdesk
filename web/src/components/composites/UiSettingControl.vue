<template>
  <div
    class="ui-setting-control"
    :class="`ui-setting-control--${setting.type}`"
  >
    <div class="ui-setting-control__copy">
      <span class="ui-setting-control__label">{{ setting.label }}</span>
      <span
        v-if="setting.description"
        class="ui-setting-control__description"
        >{{ setting.description }}</span
      >
    </div>
    <UiSwitch
      v-if="setting.type === 'toggle'"
      :model-value="Boolean(model)"
      :disabled="disabled"
      @update:model-value="setModel"
    />
    <UiInput
      v-else-if="setting.type === 'text'"
      :model-value="String(model ?? '')"
      :placeholder="setting.placeholder"
      :disabled="disabled"
      @update:model-value="setModel"
    />
    <UiNumberInput
      v-else-if="setting.type === 'number'"
      :model-value="numberValue"
      :min="setting.min"
      :max="setting.max"
      :step="setting.step"
      :disabled="disabled"
      @update:model-value="setModel"
    />
    <UiSelect
      v-else-if="setting.type === 'select'"
      :model-value="selectValue"
      :disabled="disabled"
      @update:model-value="setModel"
    >
      <option
        v-for="option in setting.options"
        :key="String(option.value)"
        :value="option.value"
        :disabled="option.disabled"
      >
        {{ option.label }}
      </option>
    </UiSelect>
    <UiButton
      v-else-if="setting.type === 'button'"
      :tone="setting.tone"
      :disabled="disabled"
      :loading="loading"
      @click="$emit('action')"
    >
      {{ setting.label }}
    </UiButton>
    <UiActionLink
      v-else-if="setting.type === 'link'"
      :href="setting.href"
      :target="setting.external ? '_blank' : undefined"
      :disabled="disabled"
    >
      {{ setting.label }}
    </UiActionLink>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type {
  UiNumberValue,
  UiSelectValue,
  UiSettingDescriptor,
} from '../../types/uiFields';
import UiActionLink from '../primitives/UiActionLink.vue';
import UiButton from '../primitives/UiButton.vue';
import UiInput from '../primitives/UiInput.vue';
import UiNumberInput from '../primitives/UiNumberInput.vue';
import UiSelect from '../primitives/UiSelect.vue';
import UiSwitch from '../primitives/UiSwitch.vue';

const props = withDefaults(
  defineProps<{
    setting: UiSettingDescriptor;
    disabled?: boolean;
    loading?: boolean;
  }>(),
  { disabled: false, loading: false },
);

defineEmits<{ action: [] }>();

const model = defineModel<string | number | boolean | null | ''>();
const numberValue = computed<UiNumberValue>(() =>
  typeof model.value === 'number' ? model.value : '',
);
const selectValue = computed<UiSelectValue>(() =>
  typeof model.value === 'string' ||
  typeof model.value === 'number' ||
  model.value === null
    ? model.value
    : '',
);

function setModel(value: string | number | boolean | null | ''): void {
  model.value = value;
}
</script>
