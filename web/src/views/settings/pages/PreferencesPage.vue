<template>
  <div class="settings-preferences"
    :data-perf-pending="performanceLoading && !loaded ? '' : undefined"
    :data-perf-error="!loaded && error && !performanceLoading ? '' : undefined">
    <p v-if="error" role="alert">{{ error }}</p>
    <UiLoadingState v-if="!loaded && !error" :label="t('settings.loadingParameters')" variant="document" >
      <UiSkeletonLayout layout="form" :header="false" />
    </UiLoadingState>
    <template v-else-if="loaded">
      <SettingsScope />
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
        <ProviderModelSelect
          v-else-if="field.key === 'arbiterModelRef'"
          :providers="providers.providers"
          :aria-label="field.label"
          :model-value="modelValue"
          :fallback-label="modelLabel"
          @update:model-value="selectModel"
        >
          <option value="">{{ t('settings.notSelected2') }}</option>
          <option v-if="modelLost || modelUnavailable" :value="modelValue" :hidden="modelUnavailable" disabled>
            {{ modelLabel }} {{ modelLost ? t('settings.missingFromRegistry2') : '' }}
          </option>
          <optgroup
            v-for="provider in providerOptions"
            :key="provider.id"
            :label="provider.name"
          >
            <option
              v-for="model in provider.models || []"
              :key="model.id"
              :value="modelKey(provider.id, model.id)"
            >
              {{ model.name || model.id }}
            </option>
          </optgroup>
        </ProviderModelSelect>
        <UiSelect
          v-else
          :aria-label="field.label"
          :model-value="String(value(field.key) ?? '')"
          :disabled="!modelValue"
          @update:model-value="edit(field.key, String($event))"
        >
          <option value="">{{ t('settings.default') }}</option>
          <option v-if="effortLost" :value="effortLost">{{ effortLost }} {{ t('settings.unavailableForThisModel') }}</option>
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
import { UiSkeletonLayout } from '../../../ui';

import { t, uiLocale } from '../../../ui.ts';

import { computed, ref, watch } from 'vue';
import {
  UiSwitch,
  UiNumberInput,
  UiSelect,
  UiLoadingState,
} from '../../../ui.ts';
import { failureText } from '../../../shared/apiClient.ts';
import { getSettingsFields } from '../../../features/settings/catalog.ts';
import { loadPreferences } from '../../../features/settings/loadPreferences.ts';
import type { JsonValue } from '../../../features/settings/contracts.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import { useProvidersStore } from '../../../stores/providers.ts';
import SettingsField from '../SettingsField.vue';
import SettingsScope from '../SettingsScope.vue';
import ProviderModelSelect from '../../../shared/ProviderModelSelect.vue';
import {
  isSelectableModelProvider, modelSelectValue as modelKey,
} from '../../../shared/providerModelSelect.ts';

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const providers = useProvidersStore();
const providerOptions = computed(() => providers.providers
  .filter(isSelectableModelProvider)
  .map((provider) => ({
    ...provider,
    models: providers.visibleModels(provider, providers.modelOf(value('arbiterModelRef')).id),
  }))
  .filter((provider) => provider.models.length));
const error = ref('');
const performanceLoading = ref(false);
const fields = computed(() => getSettingsFields(uiLocale.value).filter((field) =>
  field.resourceId === 'prefs' && field.address.pageId === settings.pageId));
const loaded = computed(() => settings.snapshot.resources.some((item) => item.id === 'prefs' && item.loaded));
const modelValue = computed(() => {
  const reference = value('arbiterModelRef');

  return reference ? JSON.stringify(reference) : '';
});
const modelLost = computed(() =>
  value('arbiterModelRef') && !providers.modelOf(value('arbiterModelRef')).model);
const modelUnavailable = computed(() => {
  const provider = providers.modelOf(value('arbiterModelRef')).provider;

  return Boolean(value('arbiterModelRef') && provider && !isSelectableModelProvider(provider));
});
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

  performanceLoading.value = true;

  try {
    try {
      await loadPreferences();
    } catch (cause) {
      error.value = failureText(cause);
    }
  } finally {
    performanceLoading.value = false;
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
.settings-preferences {
  display: grid;
  gap: 0;
  align-content: start;
  min-width: 0;
}
</style>
