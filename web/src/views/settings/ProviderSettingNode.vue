<template>
  <div
    class="native-setting"
    :class="{ 'native-setting--group': isGroup, 'native-setting--chosen': field.override.state === 'known' }"
    :data-field-id="field.id"
  >
    <template v-if="isGroup">
      <UiDisclosureButton v-model:open="open" :controls="groupId">
        {{ field.label }} <span class="native-setting__group-count">{{ childCount }}</span>
      </UiDisclosureButton>
      <div v-show="open" :id="groupId" class="native-setting__group">
        <ProviderSettingNode
          v-for="child in field.children"
          :key="child.id"
          :field="child"
          :busy="busy"
          :drafts="drafts"
          :errors="errors"
          :expand="expand"
          @draft="(id, next) => emit('draft', id, next)"
          @set="(id, next) => emit('set', id, next)"
          @unset="(id) => emit('unset', id)"
        />
      </div>
    </template>
    <template v-else>
      <div class="native-setting__row" :class="{ 'native-setting__row--switch': switchControl }">
        <div class="native-setting__copy">
          <label v-if="field.writable && field.kind !== 'array'" :for="controlId" class="native-setting__title">
            {{ field.label }}
          </label>
          <span v-else class="native-setting__title">{{ field.label }}</span>
          <p
            v-if="field.consumerSupport?.chat?.state === 'verified'
              && field.consumerSupport?.pipeline?.state === 'unsupported'"
            class="native-setting__description"
          >Только чаты</p>
          <p v-else-if="field.consumerSupport?.pipeline?.state === 'unverified'"
            class="native-setting__description">
            {{ field.consumerSupport.pipeline.reason || 'Совместимость с конвейерами не проверена' }}
          </p>
          <p v-if="descriptionSummary" class="native-setting__description">{{ descriptionSummary }}</p>
        </div>
        <ProviderSettingValue
          v-if="field.writable && field.kind !== 'array'"
          :id="controlId"
          :field="field"
          :value="value"
          :disabled="busy"
          :error="fieldError"
          :show-label="false"
          @draft="(next) => emit('draft', field.id, next)"
          @set="(next) => emit('set', field.id, next)"
        />
      </div>
      <div v-if="field.kind === 'array' && field.writable && field.items" class="native-setting__list">
        <p v-if="value === undefined" class="native-setting__description">
          Список исполнителя неизвестен. Сохранение заменит его целиком.
        </p>
        <p v-else-if="value === null" class="native-setting__description">Выбрано пустое значение (null).</p>
        <div v-for="(item, index) in array" :key="index" class="native-setting__item">
          <ProviderSettingValue
            :field="{ ...field.items, label: `Элемент ${index + 1}` }"
            :value="item"
            :commit="false"
            :disabled="busy"
            @draft="(next) => changeItem(index, next)"
          />
          <UiButton
            variant="ghost"
            :disabled="busy"
            :aria-label="`Удалить элемент ${index + 1}`"
            @click="removeItem(index)"
          >
            Удалить
          </UiButton>
        </div>
        <div class="native-setting__list-actions">
          <UiButton
            :disabled="
              busy || (field.constraints.maxItems !== undefined && array.length >= field.constraints.maxItems)
            "
            @click="addItem"
          >
            Добавить элемент
          </UiButton>
          <UiButton
            tone="accent"
            :disabled="busy || !hasDraft"
            @click="emit('set', field.id, array)"
          >
            Сохранить список
          </UiButton>
          <UiButton
            v-if="field.constraints.nullable"
            variant="ghost"
            :disabled="busy"
            @click="emit('set', field.id, null)"
          >
            Задать пустое значение (null)
          </UiButton>
        </div>
      </div>
      <p v-if="field.reason" class="native-setting__description">{{ field.reason }}</p>
      <p v-if="fieldError && (!field.writable || field.kind === 'array')" class="native-setting__error" role="alert">
        {{ fieldError }}
      </p>
      <div class="native-setting__footer">
        <span
          class="native-setting__status"
          :class="{ 'is-chosen': field.override.state === 'known', 'is-draft': hasDraft, 'is-error': fieldError }"
        >
          {{ status }}
        </span>
        <div class="native-setting__actions">
          <UiDisclosureButton
            v-if="hasDetails"
            v-model:open="detailsOpen"
            :controls="detailsId"
            density="compact"
          >
            Подробнее
          </UiDisclosureButton>
          <UiButton
            v-if="fieldError && field.writable && field.kind !== 'array' && value !== undefined"
            :disabled="busy"
            @click="emit('set', field.id, value!)"
          >
            Повторить
          </UiButton>
          <!-- Выход из текстового поля запускает сохранение до click кнопки сброса.
               Черновик разрешает поставить reset в очередь, чтобы этот click не потерялся. -->
          <UiButton
            v-if="field.override.state === 'known' || hasDraft"
            variant="ghost"
            :disabled="busy && !hasDraft"
            :aria-label="`Сбросить параметр «${field.label}»`"
            v-tooltip="'Вернуть значение исполнителя'"
            @click="emit('unset', field.id)"
          >
            Сбросить
          </UiButton>
        </div>
      </div>
      <div v-if="hasDetails" v-show="detailsOpen" :id="detailsId" class="native-setting__details">
        <template v-if="detailsOpen">
          <p v-if="field.description && descriptionSummary !== field.description">{{ field.description }}</p>
          <p>Параметр: <code>{{ field.path.join('.') }}</code></p>
          <p v-if="field.default.state === 'known'">
            Значение по схеме: <code>{{ JSON.stringify(field.default.value) }}</code>
          </p>
          <p v-if="field.base.state === 'unknown'">
            Исполнитель не сообщает текущее значение. Пока вы не сделаете выбор, оно наследуется.
          </p>
        </template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { UiButton, UiDisclosureButton, vTooltip } from '../../ui.ts';
import ProviderSettingValue from './ProviderSettingValue.vue';
import type { JsonValue, ProviderSettingNode } from '../../../../shared/providerSettingsContracts.ts';

const props = withDefaults(defineProps<{
  field: ProviderSettingNode;
  busy: boolean;
  draft?: JsonValue;
  error?: string;
  drafts?: Record<string, JsonValue>;
  errors?: Record<string, string>;
  expand?: boolean;
}>(), {
  draft: undefined,
});
const emit = defineEmits<{
  set: [id: string, value: JsonValue];
  unset: [id: string];
  draft: [id: string, value: JsonValue];
}>();

const open = ref(props.expand === true || countFields(props.field.children ?? []) <= 6);
const detailsOpen = ref(false);
const nodeId = useId().replace(/:/g, '');
const groupId = `native-group-${nodeId}`;
const detailsId = `native-details-${nodeId}`;
const controlId = `native-control-${nodeId}`;

const isGroup = computed(() => Boolean(props.field.children?.length));
const switchControl = computed(() => props.field.kind === 'boolean' && !props.field.constraints.nullable
  && props.field.base.state === 'known' && typeof props.field.base.value === 'boolean');
const descriptionSummary = computed(() => {
  const description = (props.field.description ?? '').trim().replace(/\s+/g, ' ');

  return description.length <= 160 ? description : `${description.slice(0, 157).trimEnd()}…`;
});
const hasDetails = computed(() => (props.field.description ?? '') !== descriptionSummary.value
  || props.field.default.state === 'known' || props.field.base.state === 'unknown'
  || props.field.path.join('.') !== props.field.label);
const childCount = computed(() => countFields(props.field.children ?? []));
// Чтение значения подписывает вложенное поле на добавление и удаление черновика.
// Object.hasOwn не создаёт такой зависимости в Vue; false и null остаются значениями.
const sharedDraft = computed(() => props.drafts?.[props.field.id]);
const hasDraft = computed(() => props.draft !== undefined || sharedDraft.value !== undefined);
const fieldError = computed(() => props.errors?.[props.field.id] ?? props.error);
const value = computed(() =>
  sharedDraft.value !== undefined
    ? sharedDraft.value
    : props.draft !== undefined
      ? props.draft
      : props.field.override.state === 'known'
        ? props.field.override.value
        : props.field.base.state === 'known'
          ? props.field.base.value
          : undefined,
);
const array = computed(() => (Array.isArray(value.value) ? value.value : []));
const status = computed(() => {
  if (fieldError.value) {
    return 'Не удалось сохранить';
  }

  if (hasDraft.value) {
    return props.busy ? 'Сохраняем…' : 'Не сохранено';
  }

  return props.field.override.state === 'known' ? 'Свой выбор' : 'Наследуется';
});

watch(() => props.expand, (expand) => {
  if (expand) {
    open.value = true;
  }
});

/**
 * Подпись группы сообщает число конкретных полей, а не число вложенных контейнеров.
 * После поиска и скрытия недоступных веток она считает только показанных потомков.
 */
function countFields(fields: ProviderSettingNode[]): number {
  return fields.reduce((count, field) => (
    count + (field.children?.length ? countFields(field.children) : 1)
  ), 0);
}

function changeItem(index: number, value: JsonValue): void {
  const next = [...array.value];

  next[index] = value;
  emit('draft', props.field.id, next);
}

function removeItem(index: number): void {
  emit(
    'draft',
    props.field.id,
    array.value.filter((_item, itemIndex) => itemIndex !== index),
  );
}

/**
 * Новый элемент — явный черновик после действия человека, а не подмена native base.
 * Список сохраняется атомарно после редактирования всех его элементов.
 */
function addItem(): void {
  const item = props.field.items;
  const initial = item?.constraints.enum?.length
    ? item.constraints.enum[0]!
    : item?.kind === 'boolean'
      ? false
      : item?.kind === 'number' || item?.kind === 'integer'
        ? (item.constraints.minimum ?? 0)
        : '';

  emit('draft', props.field.id, [...array.value, initial]);
}
</script>

<style scoped>
.native-setting {
  display: grid;
  min-width: 0;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  overflow-wrap: anywhere;
}

.native-setting--chosen {
  border-color: color-mix(in srgb, var(--accent) 38%, var(--line));
}

.native-setting--group {
  padding: 0;
  border: 0;
  background: transparent;
}

.native-setting p {
  margin: 0;
}

.native-setting__row,
.native-setting__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(150px, 190px);
  align-items: center;
  gap: 10px 16px;
}

.native-setting__row--switch {
  grid-template-columns: minmax(0, 1fr) auto;
}

.native-setting__copy,
.native-setting__list,
.native-setting__details,
.native-setting__group {
  display: grid;
  min-width: 0;
  gap: 6px;
}

.native-setting__title {
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}

.native-setting__description,
.native-setting__details {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.native-setting__details {
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.native-setting__details code {
  color: var(--ink);
  font-family: var(--mono);
}

.native-setting__group {
  gap: 8px;
  padding-inline-start: 10px;
  border-inline-start: 1px solid var(--line);
}

.native-setting__group-count {
  margin-inline-start: 6px;
  color: var(--ink-low);
  font-size: 12px;
}

.native-setting__footer,
.native-setting__actions,
.native-setting__list-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.native-setting__footer {
  justify-content: space-between;
}

.native-setting__status {
  color: var(--ink-low);
  font-size: 11px;
}

.native-setting__status.is-chosen {
  color: var(--accent);
}

.native-setting__status.is-draft {
  color: var(--warn);
}

.native-setting__status.is-error,
.native-setting__error {
  color: var(--bad);
}

.native-setting__item {
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

@container native-settings (max-width: 480px) {
  .native-setting__row:not(.native-setting__row--switch) {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
