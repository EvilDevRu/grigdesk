<template>
  <div class="route-context-fields">
    <label>Обязательный контекст
      <UiInput data-test="required-context" :model-value="requiredContext.join(', ')"
               @update:model-value="changeRequired" />
    </label>
    <fieldset>
      <legend>Условие блока</legend>
      <label>Путь контекста
        <UiInput data-test="when-context" :model-value="when?.context ?? ''"
                 @update:model-value="changeContext" />
      </label>
      <label>Тип значения
        <UiSelect data-test="when-type" :model-value="valueType"
                  @update:model-value="changeType">
          <option value="none">Без условия</option>
          <option value="string">Строка</option>
          <option value="number">Число</option>
          <option value="boolean">Логическое</option>
          <option value="null">null</option>
        </UiSelect>
      </label>
      <label v-if="valueType !== 'none' && valueType !== 'null'">Значение
        <UiSelect v-if="valueType === 'boolean'" data-test="when-value"
                  :model-value="String(when?.equals ?? false)"
                  @update:model-value="changeValue">
          <option value="false">false</option><option value="true">true</option>
        </UiSelect>
        <UiInput v-else data-test="when-value" :model-value="String(when?.equals ?? '')"
                 @update:model-value="changeValue" />
      </label>
    </fieldset>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RouteWhen } from '../../../../shared/routeDefinition.ts';
import { UiInput, UiSelect } from '../../ui';

const props = defineProps<{ requiredContext: string[]; when?: RouteWhen }>();
const emit = defineEmits<{
  'update:requiredContext': [value: string[]];
  'update:when': [value: RouteWhen | undefined];
}>();
const valueType = computed(() => !props.when ? 'none'
  : props.when.equals === null ? 'null' : typeof props.when.equals);

function changeRequired(value: string | number | null): void {
  emit('update:requiredContext', String(value ?? '').split(',').map((part) => part.trim()).filter(Boolean));
}

function changeContext(value: string | number | null): void {
  emit('update:when', { context: String(value ?? ''), equals: props.when ? props.when.equals : '' });
}

/**
 * Переключает тип условия блока промпта.
 * UI передаёт в черновик типизированное условие контекста.
 */
function changeType(value: string | number | null): void {
  const kind = String(value);

  if (kind === 'none') {
    emit('update:when', undefined);

    return;
  }

  const defaults: Record<string, string | number | boolean | null> = {
    string: '',
    number: 0,
    boolean: false,
    null: null,
  };
  const equals = defaults[kind];

  if (equals === undefined) {
    return;
  }

  emit('update:when', { context: props.when?.context ?? '', equals });
}

/**
 * Преобразует введённое значение в тип условия.
 * UI передаёт в черновик типизированное условие контекста.
 */
function changeValue(value: string | number | null): void {
  if (!props.when) {
    return;
  }

  const text = String(value ?? '');
  const equals = valueType.value === 'boolean' ? text === 'true'
    : valueType.value === 'number' ? Number(text) : text;

  if (typeof equals === 'number' && !Number.isFinite(equals)) {
    return;
  }

  emit('update:when', { context: props.when.context, equals });
}
</script>

<style scoped>
.route-context-fields { display: grid; gap: 8px; margin: 10px 0; }
.route-context-fields label { display: grid; gap: 4px; }
.route-context-fields fieldset { display: flex; flex-wrap: wrap; gap: 8px; border: 1px solid var(--line); }
</style>
