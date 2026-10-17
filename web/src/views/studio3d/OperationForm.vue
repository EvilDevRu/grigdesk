<template>
  <div class="studio-operation-form">
    <div :id="advancedId" class="studio-operation-fields">
      <template v-for="field in fields" :key="field.id">
        <UiField v-if="visible(field) && (!field.advanced || advanced)"
          :label="field.kind === 'toggle' ? undefined : field.label"
          :class="{ 'studio-field-wide': ['text', 'textarea', 'multiselect', 'view-prompts'].includes(field.kind),
            'studio-field-toggle': field.kind === 'toggle' }"
          :hint="field.hint ?? undefined" :required="Boolean(field.required)" :error="errorFor(field.id)">
          <UiInput v-if="field.kind === 'text'" :model-value="textValue(field.id)"
            :maxlength="field.maxLength ?? undefined" @update:model-value="set(field.id, $event)" />
          <UiTextarea v-else-if="field.kind === 'textarea'" :model-value="textValue(field.id)"
            :maxlength="field.maxLength ?? undefined" @update:model-value="set(field.id, $event)" />
          <UiNumberField v-else-if="field.kind === 'number'" :model-value="numberValue(field.id)"
            :min="field.min ?? undefined" :max="field.max ?? undefined" :step="field.step ?? 1"
            @update:model-value="set(field.id, $event === '' ? null : $event)" />
          <UiSelect v-else-if="field.kind === 'select'" :model-value="textValue(field.id)"
            @update:model-value="set(field.id, $event)">
            <option v-for="option in field.options ?? []" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </UiSelect>
          <UiSwitch v-else-if="field.kind === 'toggle'" :model-value="Boolean(model[field.id])"
            @update:model-value="set(field.id, $event)">{{ field.label }}</UiSwitch>
          <div v-else-if="field.kind === 'multiselect'" class="studio-choices">
            <UiSearchInput v-if="(field.options?.length ?? 0) > 20" v-model="searches[field.id]"
              label="Поиск вариантов" />
            <div v-for="group in groups(field)" :key="group.label" class="studio-choice-group">
              <h5 v-if="group.label">{{ group.label }}</h5>
              <UiChoiceList :model-value="multiValue(field.id)" :options="group.options" mode="multiple"
                :label="group.label || field.label" @update:model-value="setMulti(field.id, $event)" />
            </div>
          </div>
          <div v-else-if="field.kind === 'view-prompts'" class="studio-view-prompts">
            <UiField v-for="view in views" :key="view.id" :label="view.label">
              <UiTextarea :model-value="viewText(field.id, view.id)"
                @update:model-value="setView(field.id, view.id, String($event))" />
            </UiField>
          </div>
        </UiField>
      </template>
    </div>
    <UiDisclosureButton v-if="fields.some((field) => field.advanced)" v-model:open="advanced"
      :controls="advancedId">Дополнительные параметры</UiDisclosureButton>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, useId } from 'vue';
import { UiField, UiInput, UiTextarea, UiNumberField, UiSelect, UiSwitch, UiChoiceList,
  UiSearchInput, UiDisclosureButton } from '../../ui.ts';
import type { Studio3dField } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { FieldValues, FieldValue,
  ViewPrompt } from '../../../../shared/studio3d/studio3dOperations.ts';

const props = withDefaults(defineProps<{
  fields: Studio3dField[];
  errors?: { field?: string | null; message: string }[];
}>(), {
  errors: () => [],
});
const model = defineModel<FieldValues>({ required: true });
const advanced = ref(false);
const advancedId = `studio-advanced-${useId()}`;
const searches = ref<Record<string, string>>({});
const views = [
  { id: 'front' as const, label: 'Спереди' }, { id: 'left' as const, label: 'Слева' },
  { id: 'back' as const, label: 'Сзади' }, { id: 'right' as const, label: 'Справа' },
];

/**
 * VisibleWhen сопоставляет только значения объявленных полей, без исполнения строк.
 * Скрытие поля не придумывает новое значение: нормализацию делает quote сервера.
 */
function visible(field: Studio3dField): boolean {
  return (field.visibleWhen ?? []).every((condition) => {
    const value = model.value[condition.field];
    
    return (!condition.is || condition.is.some((item) => Object.is(item, value)))
      && (!condition.not || !condition.not.some((item) => Object.is(item, value)));
  });
}

/**
 * Изменение всегда создаёт новый объект формы для watch/поколения цены владельца.
 * FieldValues сохраняет закрытые простые типы, без объектных значений select.
 */
function set(id: string, value: FieldValue): void {
  model.value = { ...model.value, [id]: value };
}

const textValue = (id: string) => typeof model.value[id] === 'string' ? String(model.value[id]) : '';
const numberValue = (id: string) => typeof model.value[id] === 'number' ? model.value[id] as number : '';
const errorFor = (id: string) => props.errors.find((issue) => issue.field === id)?.message;
const multiValue = (id: string) => Array.isArray(model.value[id])
  ? (model.value[id] as FieldValue[]).filter((value): value is string => typeof value === 'string') : [];
const setMulti = (id: string, value: unknown) => set(id,
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/**
 * Поиск фильтрует варианты внутри исходных групп и не выбрасывает выбранные движения.
 * UiChoiceList всех групп разделяет один массив значений соответствующего поля.
 */
function groups(field: Studio3dField) {
  const search = (searches.value[field.id] ?? '').trim().toLocaleLowerCase('ru');
  const grouped = new Map<string, {
    value: string;
    label: string;
    description?: string
  }[]>();
  
  for (const option of field.options ?? []) {
    if (search && !option.label.toLocaleLowerCase('ru').includes(search)) {
      continue;
    }
    
    const label = option.group ?? '';
    const options = grouped.get(label) ?? [];
    
    options.push({
      value: option.value,
      label: option.label,
      description: option.hint ?? undefined
    });
    grouped.set(label, options);
  }
  
  return [...grouped].map(([label, options]) => ({ label, options }));
}

/**
 * Правки видов читают только именованные четыре вида, без произвольных ключей.
 * Пустое поле удаляет правку вместо добавления ложного непустого задания.
 */
function viewText(id: string, view: ViewPrompt['view']): string {
  const values = model.value[id];
  
  if (!Array.isArray(values)) {
    return '';
  }
  
  return values.find((value): value is ViewPrompt => typeof value === 'object'
    && value?.view === view)?.prompt ?? '';
}

/**
 * Пересборка массива сохраняет фиксированный порядок и остальные непустые виды.
 * Каждая правка остаётся простым {view,prompt}, пригодным для closed DTO.
 */
function setView(id: string, view: ViewPrompt['view'], prompt: string): void {
  set(id, views.map((item) => ({ view: item.id, prompt: item.id === view ? prompt : viewText(id, item.id) }))
    .filter((item) => item.prompt.trim()));
}

watch(() => props.errors, (errors) => {
  if (errors.some((issue) => props.fields.some((field) => field.id === issue.field && field.advanced))) {
    advanced.value = true;
  }
}, { immediate: true, deep: true });
</script>

<style scoped>
.studio-operation-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  container: studio-form / inline-size;
}

.studio-operation-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 16px;
}

.studio-field-wide {
  grid-column: 1 / -1;
}

.studio-field-toggle {
  align-self: center;
}

.studio-choices {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.studio-view-prompts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.studio-choice-group h5 {
  margin: 8px 0;
}

@container studio-form (max-width: 419px) {
  .studio-operation-fields,
  .studio-view-prompts {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
