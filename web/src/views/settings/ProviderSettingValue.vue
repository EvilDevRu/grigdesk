<template>
  <div class="native-setting-value">
    <UiField
      :id="id"
      :label="showLabel && !booleanSwitch ? field.label : undefined"
      :error="error"
      :hint="commit && textInput ? 'Enter или выход из поля — сохранить' : undefined"
    >
      <UiSwitch
        v-if="booleanSwitch"
        :id="id"
        :model-value="input === true"
        :aria-label="field.label"
        :aria-describedby="error ? `${id}-error` : undefined"
        :aria-invalid="Boolean(error) || undefined"
        :disabled="disabled"
        @update:model-value="choose"
      >
        {{ showLabel ? field.label : input === true ? 'Включено' : 'Выключено' }}
      </UiSwitch>
      <UiSelect
        v-else-if="field.kind === 'enum' || field.kind === 'boolean'"
        :model-value="optionId"
        :disabled="disabled"
        @update:model-value="select"
      >
        <option value="" disabled>Выбирает исполнитель</option>
        <option v-for="(option, index) in choices" :key="index" :value="`option-${index}`">
          {{ describe(option) }}
        </option>
      </UiSelect>
      <UiNumberInput
        v-else-if="field.kind === 'number' || field.kind === 'integer'"
        :model-value="typeof input === 'number' ? input : ''"
        :min="field.constraints.minimum"
        :max="field.constraints.maximum"
        :step="field.constraints.step ?? (field.kind === 'integer' ? 1 : 'any')"
        :disabled="disabled"
        :aria-label="field.label"
        :placeholder="input === null ? 'Пустое значение (null)' : 'Укажите число'"
        @update:model-value="editNumber"
        @change="save"
        @keydown.enter.prevent="commitInput"
      />
      <UiInput
        v-else-if="field.kind === 'string'"
        :model-value="typeof input === 'string' ? input : ''"
        :minlength="field.constraints.minLength"
        :maxlength="field.constraints.maxLength"
        :disabled="disabled"
        :aria-label="field.label"
        :placeholder="input === null ? 'Пустое значение (null)' : 'Укажите значение'"
        @update:model-value="editString"
        @change="save"
        @keydown.enter.prevent="commitInput"
      />
    </UiField>
    <UiButton
      v-if="field.constraints.nullable && field.kind !== 'enum'"
      variant="ghost"
      :disabled="disabled"
      @click="choose(null)"
    >
      Задать пустое значение (null)
    </UiButton>
    <UiButton
      v-if="field.kind === 'string' && input === null"
      variant="ghost"
      :disabled="disabled"
      @click="choose('')"
    >
      Задать пустую строку
    </UiButton>
  </div>
</template>

<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import { UiButton, UiField, UiInput, UiNumberInput, UiSelect, UiSwitch } from '../../ui.ts';
import type { JsonValue, ProviderSettingNode } from '../../../../shared/chat/providerSettingsContracts.ts';

const props = withDefaults(
  defineProps<{
    field: ProviderSettingNode;
    id?: string;
    showLabel?: boolean;
    value?: JsonValue;
    disabled: boolean;
    error?: string;
    commit?: boolean;
  }>(),
  {
    value: undefined,
    id: undefined,
    showLabel: true,
    error: undefined,
    commit: true,
  },
);
const emit = defineEmits<{ draft: [value: JsonValue]; set: [value: JsonValue] }>();

const input = shallowRef<JsonValue | undefined>(props.value);
const booleanSwitch = computed(() => props.field.kind === 'boolean' && !props.field.constraints.nullable
  && (props.commit === false || (props.field.base.state === 'known'
    && typeof props.field.base.value === 'boolean')));
const textInput = computed(() => ['string', 'number', 'integer'].includes(props.field.kind));
const choices = computed<JsonValue[]>(() =>
  props.field.kind === 'boolean'
    ? [...[true, false], ...(props.field.constraints.nullable ? [null] : [])]
    : (props.field.constraints.enum ?? []),
);
const optionId = computed(() => {
  const index = choices.value.findIndex((value) => JSON.stringify(value) === JSON.stringify(input.value));

  return index < 0 ? '' : `option-${index}`;
});
const mixedChoices = computed(() => choices.value.some((value) => typeof value !== 'string'));

/**
 * Подпись различает исходные JSON-типы, включая число, строку и null.
 * Видимое представление не подменяет значение, которое отправится серверу.
 */
function describe(value: JsonValue): string {
  return typeof value === 'string'
    ? mixedChoices.value ? JSON.stringify(value) : value
    : value === null
      ? 'Пустое значение (null)'
      : typeof value === 'boolean'
        ? value
          ? 'Да (true)'
          : 'Нет (false)'
        : String(value);
}

/**
 * Редактор хранит ввод до смены props, чтобы change того же DOM-события
 * не отправлял прежнее значение до обновления Vue.
 */
function edit(value: JsonValue): void {
  input.value = value;
  emit('draft', value);
}

function editString(value: unknown): void {
  edit(String(value ?? ''));
}

function editNumber(value: unknown): void {
  if (value === '' || (typeof value === 'number' && Number.isFinite(value))) {
    edit(value);
  }
}

function save(): void {
  if (props.commit && input.value !== undefined) {
    emit('set', input.value);
  }
}

function commitInput(event: KeyboardEvent): void {
  (event.target as HTMLInputElement).blur();
}

function choose(value: JsonValue): void {
  edit(value);
  save();
}

/**
 * Option id принадлежит только UI; сервер получает исходный JSON-тип.
 * Пустой placeholder не становится ни null, ни unset.
 */
function select(value: unknown): void {
  const match = String(value).match(/^option-(\d+)$/);
  const option = match ? choices.value[Number(match[1])] : undefined;

  if (option !== undefined) {
    choose(option);
  }
}

watch(
  () => props.value,
  (value) => {
    input.value = value;
  },
);
</script>

<style scoped>
.native-setting-value {
  display: grid;
  min-width: 0;
  gap: 6px;
}
</style>
