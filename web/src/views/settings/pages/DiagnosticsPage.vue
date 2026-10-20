<template>
  <div class="settings-diagnostics">
    <SettingsScope />
    <p v-if="error" role="alert">{{ error }}</p>
    <SettingsField
      v-for="field in fields"
      :key="field.key"
      :address="field.address"
    >
      <UiSelect
        v-if="loaded"
        :model-value="level"
        :aria-label="field.label"
        @update:model-value="edit"
      >
        <option
          v-for="choice in FACTORY_DEBUG_LEVELS"
          :key="choice.value"
          :value="choice.value"
        >
          {{ choice.label }}
        </option>
      </UiSelect>
    </SettingsField>
    <p v-if="details">Действует: {{ details.effective }} · источник: {{ details.source }}</p>
    <SettingsSection>
      <WebLogPanel v-if="active" />
    </SettingsSection>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { UiSelect } from '../../../ui.ts';
import { api, failureText } from '../../../shared/apiClient.ts';
import { FACTORY_DEBUG_LEVELS } from '../../../shared/factory-debug.js';
import { getWebLogRuntime } from '../../../shared/webLogRuntime.ts';
import { sseSubscribe } from '../../../composables/useSse.ts';
import { SETTINGS_FIELDS } from '../../../features/settings/catalog.ts';
import { createFactoryDebugAdapter } from '../../../features/settings/resources/factoryDebug.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import SettingsField from '../SettingsField.vue';
import SettingsScope from '../SettingsScope.vue';
import SettingsSection from '../SettingsSection.vue';
import WebLogPanel from '../WebLogPanel.vue';

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const error = ref('');
const fields = SETTINGS_FIELDS.filter((field) => field.resourceId === 'factoryDebug');
const loaded = computed(() => settings.snapshot.resources.some((item) =>
  item.id === 'factoryDebug' && item.loaded));
const details = computed(() => settings.resourceDetails.factoryDebug);
const level = computed(() => {
  settings.snapshot;

  return String(settings.getValue('factoryDebug', 'level') ?? 'off');
});

function edit(value: unknown): void {
  settings.setField('factoryDebug', 'level', String(value));
}

/**
 * Чтение и SSE обновляют исходный снимок, не переписывая dirty-поле.
 * Подписка живёт в сессии и снимается при закрытии, включая потерю авторизации.
 */
async function load(): Promise<void> {
  if (!props.active || !settings.isOpen) {
    return;
  }

  if (settings.snapshot.resources.some((item) => item.id === 'factoryDebug')) {
    await settings.loadResource('factoryDebug');

    return;
  }

  const opening = settings.snapshot.sessionId;
  const adapter = createFactoryDebugAdapter(api, (view) => {
    if (!settings.isOpen || settings.snapshot.sessionId !== opening) {
      return;
    }

    settings.resourceDetails = {
      ...settings.resourceDetails,
      factoryDebug: { effective: view.effective, source: view.source },
    };
    getWebLogRuntime()?.applyPolicy(view.effective, view.expiresAt);
  });

  try {
    settings.registerResource(adapter, fields);
    await settings.loadResource('factoryDebug');

    if (!settings.isOpen || settings.snapshot.sessionId !== opening) {
      return;
    }

    settings.bindSession('factoryDebug', () => {
      const controller = new AbortController();
      const unsubscribe = sseSubscribe((name) => {
        if (name === 'diagnostic-logging') {
          void adapter.read(controller.signal).then((values) => {
            settings.acceptSnapshot('factoryDebug', values, opening);
          }).catch(() => undefined);
        }
      });

      return () => {
        controller.abort();
        unsubscribe();
      };
    });
  } catch (cause) {
    error.value = failureText(cause);
  }
}

watch(() => props.active, load, { immediate: true });
</script>

<style scoped>
.settings-diagnostics {
  display: grid;
  gap: 16px;
  align-content: start;
  min-width: 0;
}
.settings-diagnostics > p {
  margin: 0;
  color: var(--ink-mid);
  font-size: 11px;
}
</style>
