<template>
  <div class="settings-preferences">
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="!loaded">Загрузка параметров…</p>
    <template v-else>
      <p>Все устройства · Изменения сохранятся по «Применить».</p>
      <SettingsField
        v-for="field in fields"
        :key="field.key"
        :address="field.address"
      >
        <UiSwitch
          v-if="field.control === 'switch'"
          :aria-label="field.label"
          :model-value="value(field.key) === true"
          @update:model-value="edit(field.key, $event)"
        />
        <UiNumberInput
          v-else-if="field.control === 'number'"
          :aria-label="field.label"
          :model-value="numberValue(field.key)"
          :min="0"
          :step="field.key === 'runSilenceWindow' ? 'any' : 1"
          @update:model-value="edit(field.key, $event)"
        />
        <UiSelect
          v-else-if="field.key === 'arbiterModelRef'"
          :aria-label="field.label"
          :model-value="modelValue"
          @update:model-value="selectModel"
        >
          <option value="">Не выбрана</option>
          <option v-if="modelLost" :value="modelValue">{{ modelLabel }} — нет в реестре</option>
          <optgroup
            v-for="provider in providerOptions"
            :key="provider.id"
            :label="provider.name + (provider.available ? '' : ' — недоступен')"
          >
            <option
              v-for="model in provider.models || []"
              :key="model.id"
              :value="modelKey(provider.id, model.id)"
            >
              {{ model.name || model.id }}
            </option>
          </optgroup>
        </UiSelect>
        <UiSelect
          v-else
          :aria-label="field.label"
          :model-value="String(value(field.key) ?? '')"
          :disabled="!modelValue"
          @update:model-value="edit(field.key, String($event))"
        >
          <option value="">По умолчанию</option>
          <option v-if="effortLost" :value="effortLost">{{ effortLost }} — нет у этой модели</option>
          <option
            v-for="level in effortLevels"
            :key="level"
            :value="level"
          >
            {{ level }}
          </option>
        </UiSelect>
      </SettingsField>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { UiSwitch, UiNumberInput, UiSelect } from '../../../ui.ts';
import { api, failureText } from '../../../shared/apiClient.ts';
import { SETTINGS_FIELDS } from '../../../features/settings/catalog.ts';
import { createPreferencesAdapter } from '../../../features/settings/resources/preferences.ts';
import type { ProviderEntry } from '../../../../../shared/chat/providersContracts.ts';
import type { JsonValue } from '../../../features/settings/contracts.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import { useChatStore } from '../../../stores/chat.js';
import { useProvidersStore } from '../../../stores/providers.js';
import SettingsField from '../SettingsField.vue';

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const providers = useProvidersStore();
const providerOptions = computed(() => providers.providers as ProviderEntry[]);
const error = ref('');
const fields = computed(() => SETTINGS_FIELDS.filter((field) =>
  field.resourceId === 'prefs' && field.address.pageId === settings.pageId));
const loaded = computed(() => settings.snapshot.resources.some((item) => item.id === 'prefs' && item.loaded));
const modelValue = computed(() => {
  const reference = value('arbiterModelRef');

  return reference ? JSON.stringify(reference) : '';
});
const modelLost = computed(() =>
  value('arbiterModelRef') && !providers.modelOf(value('arbiterModelRef')).model);
const modelLabel = computed(() => {
  const reference = value('arbiterModelRef') as { provider: string; model: string } | null;

  return reference ? `${reference.provider}:${reference.model}` : '';
});
const effortLevels = computed<string[]>(() =>
  providers.modelOf(value('arbiterModelRef')).model?.efforts ?? []);
const effortLost = computed(() => {
  const effort = String(value('arbiterEffort') ?? '');

  return effort && !effortLevels.value.includes(effort) ? effort : '';
});

function value(key: string): JsonValue | undefined {
  settings.snapshot;

  return settings.getValue('prefs', key);
}

function numberValue(key: string): number | '' {
  const current = value(key);

  return typeof current === 'number' ? current : '';
}

function edit(key: string, next: JsonValue): void {
  settings.setField('prefs', key, next);
}

function modelKey(provider: string, model: string): string {
  return JSON.stringify({ provider, model });
}

/**
 * При явной смене модели переносится только поддерживаемая ею ступень усилия.
 * Переключение auto само по себе не меняет ни modelRef, ни effort.
 */
function selectModel(encoded: unknown): void {
  const reference = JSON.parse(String(encoded || 'null')) as JsonValue;

  edit('arbiterModelRef', reference);

  const levels: string[] = providers.modelOf(reference).model?.efforts ?? [];

  if (!levels.includes(String(value('arbiterEffort') ?? ''))) {
    edit('arbiterEffort', '');
  }
}

/**
 * Регистрируется весь ресурс prefs, хотя текущая страница показывает его часть.
 * Сессия загружает его один раз и сохраняет адаптер после размонтирования формы.
 */
async function load(): Promise<void> {
  if (!props.active) {
    return;
  }

  try {
    settings.registerResource(createPreferencesAdapter(api, (values) => {
      if (typeof values.chatAutoCompactWindow === 'number') {
        useChatStore().compactWindow = values.chatAutoCompactWindow;
      }

      if (typeof values.showAllModels === 'boolean') {
        providers.showAllModels = values.showAllModels;
      }
    }), SETTINGS_FIELDS.filter((field) => field.resourceId === 'prefs'));
    await settings.loadResource('prefs');
  } catch (cause) {
    error.value = failureText(cause);
  }
}

watch(() => props.active, load, { immediate: true });
watch(() => settings.pageId, () => {
  if (props.active && settings.pageId === 'automation.arbiter' && !providers.loaded) {
    void providers.load();
  }
}, { immediate: true });
</script>

<style scoped>
.settings-preferences { display: grid; gap: 20px; align-content: start; max-width: 760px; }
</style>
