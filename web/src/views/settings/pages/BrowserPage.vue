<template>
  <section>
    <SettingsScope :scope="t('settings.thisDevice2')" />
    <p v-if="!browser.available" role="status">{{ t('core.browserDesktopOnly') }}</p>
    <p v-if="error" role="alert">{{ t('core.browserRequestFailed') }}</p>
    <p v-if="browser.available && !loaded && !error" role="status">{{ t('core.browserLoading') }}</p>
    <SettingsField v-for="field in fields" :key="field.key" :address="field.address">
      <UiSelect
        v-if="field.key === 'open'"
        :aria-label="field.label"
        :model-value="String(value('open') ?? 'external')"
        :disabled="disabled"
        @update:model-value="edit('open', String($event))"
      >
        <option value="internal">{{ t('settings.browserInternal') }}</option>
        <option value="external">{{ t('settings.browserExternal') }}</option>
      </UiSelect>
      <UiSelect
        v-else-if="field.key === 'search'"
        :aria-label="field.label"
        :model-value="String(value('search') ?? 'yandex')"
        :disabled="disabled"
        @update:model-value="edit('search', String($event))"
      >
        <option value="yandex">{{ t('settings.browserYandex') }}</option>
        <option value="google">{{ t('settings.browserGoogle') }}</option>
      </UiSelect>
      <template v-else-if="field.key === 'external'">
        <UiSelect
          :aria-label="field.label"
          :model-value="String(value('external') ?? 'system')"
          :disabled="disabled || value('open') === 'internal'"
          @update:model-value="edit('external', String($event))"
        >
          <option value="system">{{ t('settings.browserSystem') }}</option>
          <option v-if="missingApp" :value="String(value('external'))">
            {{ t('settings.browserSelectedUnavailable') }}
          </option>
          <option v-for="app in browser.apps" :key="app.id" :value="app.id">{{ app.name }}</option>
        </UiSelect>
        <UiButton :disabled="disabled || choosing" @click="choose">
          {{ t('settings.browserChooseApplication') }}
        </UiButton>
      </template>
      <UiSwitch
        v-else
        :aria-label="field.label"
        :model-value="value('agents') === true"
        :disabled="disabled"
        @update:model-value="edit('agents', $event)"
      />
    </SettingsField>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { UiButton, UiSelect, UiSwitch, t, uiLocale } from '../../../ui.ts';
import { useBrowserStore } from '../../../stores/browser.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import { SETTINGS_FIELDS, getSettingsFields } from '../../../features/settings/catalog.ts';
import { createBrowserSettingsAdapter } from '../../../features/settings/resources/browser.ts';
import type { JsonValue } from '../../../features/settings/contracts.ts';
import SettingsScope from '../SettingsScope.vue';
import SettingsField from '../SettingsField.vue';

const props = defineProps<{ active: boolean }>();
const browser = useBrowserStore();
const settings = useSettingsStore();
const error = ref(false);
const choosing = ref(false);
const fields = computed(() => getSettingsFields(uiLocale.value)
  .filter((field) => field.resourceId === 'browser'));
const loaded = computed(() => settings.snapshot.resources
  .some((resource) => resource.id === 'browser' && resource.loaded));
const disabled = computed(() => !browser.available || !loaded.value || settings.snapshot.applying);
const missingApp = computed(() => value('external') !== undefined && value('external') !== 'system'
  && !browser.apps.some((app) => app.id === value('external')));
let mounted = true;

function value(key: string): JsonValue | undefined {
  settings.snapshot;

  return settings.getValue('browser', key);
}

function edit(key: string, next: JsonValue): void {
  settings.setField('browser', key, next);
}

/**
 * Выбор executable регистрирует только приложение, а поле внешнего браузера остаётся draft.
 * Поздний ответ file picker не меняет уже закрытую или следующую сессию настроек.
 */
async function choose(): Promise<void> {
  const opening = settings.snapshot.sessionId;

  choosing.value = true;
  error.value = false;

  try {
    const selected = await browser.chooseApp();

    if (selected && mounted && settings.isOpen && settings.snapshot.sessionId === opening) {
      edit('external', selected.id);
    }
  } catch {
    if (mounted && settings.snapshot.sessionId === opening) {
      error.value = true;
    }
  } finally {
    choosing.value = false;
  }
}

/**
 * Регистрация и чтение принадлежат общей staged-сессии, не локальному submit страницы.
 * Уход со страницы сохраняет dirty intentions; Apply вызывает единственную native запись.
 */
async function load(): Promise<void> {
  if (!props.active || !settings.isOpen || !browser.available) {
    return;
  }

  const opening = settings.snapshot.sessionId;

  try {
    settings.registerResource(createBrowserSettingsAdapter({
      read: async (signal) => {
        signal.throwIfAborted();

        const snapshot = await browser.native({ operation: 'state' });

        signal.throwIfAborted();
        browser.apply(snapshot);

        return browser.snapshot.preferences;
      },
      write: async (patch, signal) => {
        signal.throwIfAborted();

        return browser.native({ operation: 'preferences', value: patch });
      },
      disablePreference: () => browser.disablePreference(),
    }), SETTINGS_FIELDS.filter((field) => field.resourceId === 'browser'));
    await Promise.all([settings.loadResource('browser'), browser.loadApps()]);
  } catch {
    if (mounted && settings.snapshot.sessionId === opening) {
      error.value = true;
    }
  }
}

watch([() => props.active, () => settings.isOpen, () => browser.available], load, { immediate: true });
onBeforeUnmount(() => {
  mounted = false;
});
</script>
