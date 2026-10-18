<template>
  <div class="settings-native-value">
    <UiSwitch
      v-if="field.kind === 'boolean' && !field.constraints.nullable
      && field.base.state === 'known' && typeof value === 'boolean'"
      :model-value="value"
      :disabled="disabled"
      :aria-label="field.label"
      @update:model-value="choose"
    />
    <UiSelect
      v-else-if="field.kind === 'enum' || field.kind === 'boolean'"
      :model-value="optionId"
      :disabled="disabled"
      :aria-label="field.label"
      @update:model-value="select"
    >
      <option value="" disabled>Выбирает исполнитель</option>
      <option
        v-for="(choice, index) in choices"
        :key="index"
        :value="String(index)"
      >
        {{ describe(choice) }}
      </option>
    </UiSelect>
    <UiNumberInput
      v-else-if="['number', 'integer'].includes(field.kind)"
      :model-value="typeof value === 'number' ? value : ''"
      :disabled="disabled"
      :aria-label="field.label"
      :min="field.constraints.minimum"
      :max="field.constraints.maximum"
      :step="field.constraints.step ?? (field.kind === 'integer' ? 1 : 'any')"
      :placeholder="value === null ? 'Пустое значение (null)' : 'Укажите число'"
      @update:model-value="choose"
    />
    <UiInput
      v-else-if="field.kind === 'string'"
      :model-value="typeof value === 'string' ? value : ''"
      :disabled="disabled"
      :aria-label="field.label"
      :minlength="field.constraints.minLength"
      :maxlength="field.constraints.maxLength"
      :placeholder="value === null ? 'Пустое значение (null)' : ''"
      @update:model-value="choose"
    />
    <UiButton
      v-if="field.constraints.nullable && field.kind !== 'enum'"
      :disabled="disabled"
      @click="choose(null)"
    >
      Задать пустое значение (null)
    </UiButton>
    <UiButton
      v-if="field.kind === 'string' && value === null"
      :disabled="disabled"
      @click="choose('')"
    >
      Задать пустую строку
    </UiButton>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { UiSwitch, UiSelect, UiNumberInput, UiInput, UiButton } from '../../../ui.ts';
import type { JsonValue, ProviderSettingNode } from '../../../../../shared/chat/providerSettingsContracts.ts';

const props = defineProps<{
  field: ProviderSettingNode;
  value?: JsonValue;
  disabled?: boolean;
}>();
const emit = defineEmits<{ change: [value: JsonValue] }>();
const choices = computed<JsonValue[]>(() => props.field.kind === 'boolean'
  ? [true, false, ...(props.field.constraints.nullable ? [null] : [])] : props.field.constraints.enum ?? []);
const optionId = computed(() => {
  const index = choices.value.findIndex((choice) => JSON.stringify(choice) === JSON.stringify(props.value));

  return index < 0 ? '' : String(index);
});

function choose(value: JsonValue): void {
  emit('change', value);
}

function select(value: unknown): void {
  const index = Number(value);

  if (String(value) !== '' && Number.isInteger(index) && choices.value[index] !== undefined) {
    choose(choices.value[index]!);
  }
}

/**
 * Текст различает число, строку и null, не меняя исходный JSON-тип option.
 * Placeholder не является значением и не создаёт set или unset.
 */
function describe(value: JsonValue): string {
  return value === null ? 'Пустое значение (null)' : typeof value === 'string'
    ? choices.value.some((choice) => typeof choice !== 'string') ? JSON.stringify(value) : value
    : typeof value === 'boolean' ? value ? 'Да (true)' : 'Нет (false)' : String(value);
}
</script>

<style scoped>
.settings-native-value { display: grid; gap: 8px; min-width: 0; }
</style>
