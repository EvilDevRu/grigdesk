<template>
  <section
    class="settings-connections"
    :data-connections-page="settings.pageId"
    :data-ready="ready"
  >
    <template v-if="settings.pageId === 'connections.b24'">
      <p>Все устройства · Подключение изменится по «Применить».</p>
      <p>{{ configured ? 'Подключение настроено' : 'Подключение не настроено' }}</p>
      <SettingsField
        v-for="field in fields"
        :key="field.key"
        :address="field.address"
      >
        <UiPasswordInput
          v-if="field.key === 'password'"
          :model-value="value(field.key)"
          :aria-label="field.label"
          autocomplete="new-password"
          placeholder="Введите новый пароль для сохранения изменений"
          @update:model-value="edit(field.key, $event)"
        />
        <UiInput
          v-else
          :model-value="value(field.key)"
          :aria-label="field.label"
          @update:model-value="edit(field.key, $event)"
        />
      </SettingsField>
      <UiButton :disabled="!configured || dirty || testing" @click="testConnection">
        Проверить подключение
      </UiButton>
      <p v-if="dirty">Сначала примените изменения подключения.</p>
    </template>
    <template v-else>
      <MobileAccess />
      <UiDisclosureButton v-model:open="help" :controls="helpId">Вход на этом компьютере</UiDisclosureButton>
      <div v-if="help" :id="helpId">
        <p>Автоматический вход по локальному ключу этого компьютера.</p>
        <p>
          Если сессия потеряется, главное окно восстановит вход само. Чтобы защитить доступ, блокируйте экран
          компьютера.
        </p>
      </div>
    </template>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, useId } from 'vue';
import { UiInput, UiPasswordInput, UiButton, UiDisclosureButton } from '../../../ui.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import { SETTINGS_FIELDS } from '../../../features/settings/catalog.ts';
import { createB24Adapter } from '../../../features/settings/resources/connections.ts';
import { api, failureText } from '../../../shared/apiClient.ts';
import MobileAccess from '../MobileAccess.vue';
import SettingsField from '../SettingsField.vue';

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const fields = SETTINGS_FIELDS.filter((field) => field.resourceId === 'b24');
const configured = computed(() => settings.resourceDetails.b24?.configured === true);
const dirty = computed(() => settings.snapshot.resources.find((entry) => entry.id === 'b24')
  ?.fields.some((field) => field.dirty) === true);
const help = ref(false);
const helpId = `settings-local-access-${useId()}`;
const ready = ref(false);
const testing = ref(false);
const message = ref('');
const error = ref('');

function value(key: string): string {
  settings.snapshot;

  return String(settings.getValue('b24', key) ?? '');
}

function edit(key: string, value: unknown): void {
  if (key === 'password' && value === '') {
    settings.discardField('b24', key);
  } else {
    settings.setField('b24', key, String(value ?? ''));
  }
}

/**
 * Проверка использует сохранённое подключение и потому запрещена при dirty Б24.
 * Она не применяет параметры других страниц и не отправляет содержимое черновика.
 */
async function testConnection(): Promise<void> {
  if (!configured.value || dirty.value || testing.value) {
    return;
  }

  testing.value = true;

  try {
    const result = await api.post('/api/settings/b24/test') as { ok: boolean; error?: string };

    message.value = result.ok ? 'Подключение проверено.' : result.error || 'Подключение не подтверждено';
  } catch (cause) {
    error.value = failureText(cause);
  } finally {
    testing.value = false;
  }
}

/**
 * Секрет регистрируется без baseline: сервер возвращает только configured.
 * Обновлённый снимок принадлежит текущему открытию и не оживляет закрытую форму.
 */
async function load(): Promise<void> {
  if (!props.active || !settings.isOpen) {
    return;
  }

  if (settings.pageId !== 'connections.b24') {
    ready.value = true;

    return;
  }

  const opening = settings.snapshot.sessionId;

  try {
    const adapter = settings.sessionService('b24-adapter', () => createB24Adapter(api, (view) => {
      if (settings.isOpen && settings.snapshot.sessionId === opening) {
        settings.resourceDetails = { ...settings.resourceDetails, b24: { configured: view.configured } };
      }
    }));

    settings.registerResource(adapter, fields.map((field) => ({
      ...field,
      secret: field.key === 'password',
    })));
    await settings.loadResource('b24');
    ready.value = true;
  } catch (cause) {
    error.value = failureText(cause);
  }
}

watch([() => props.active, () => settings.pageId], load, { immediate: true });
</script>

<style scoped>
.settings-connections { display: grid; gap: 16px; min-width: 0; align-content: start; }
.settings-connections p { margin: 0; }
</style>
