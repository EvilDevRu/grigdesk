<template>
  <SettingsSection :heading="t('settings.providerUsageAutoRefresh')">
    <p v-if="visibleError" role="alert">{{ visibleError }}</p>
    <UiButton v-if="visibleError" data-usage-prefs-retry @click="load">{{ t('settings.recheck') }}</UiButton>
    <SettingsField v-if="loaded" :address="address">
      <UiSwitch
        :aria-label="t('settings.providerUsageAutoRefresh')"
        :model-value="settings.getValue('prefs', 'providerUsageAutoRefresh') === true"
        :disabled="settings.snapshot.applying"
        @update:model-value="edit"
      />
    </SettingsField>
    <p v-else-if="!visibleError">{{ t('settings.loading') }}</p>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { t, UiSwitch, UiButton } from '../../ui.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { failureText } from '../../shared/apiClient.ts';
import { loadPreferences } from '../../features/settings/loadPreferences.ts';
import SettingsSection from './SettingsSection.vue';
import SettingsField from './SettingsField.vue';

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const error = ref('');
const visibleError = computed(() => error.value || settings.resourceDetails.prefsPolicy?.error || '');
const address = { pageId: 'agents.providers', fieldPath: ['providerUsageAutoRefresh'] };
const loaded = computed(() => settings.snapshot.resources.some((resource) =>
  resource.id === 'prefs' && resource.loaded));

function edit(value: boolean): void {
  settings.setField('prefs', 'providerUsageAutoRefresh', value);
}

/**
 * Параметр загружается для всего открытия настроек, независимо от выбранного аккаунта.
 * Сбой чтения виден и повторяется без скрытой записи или сброса текущего черновика.
 */
async function load(): Promise<void> {
  if (!props.active || !settings.isOpen) {
    return;
  }

  error.value = '';

  try {
    await loadPreferences();
  } catch (cause) {
    error.value = failureText(cause);
  }
}

watch([() => props.active, () => settings.snapshot.sessionId], load, { immediate: true });
</script>
