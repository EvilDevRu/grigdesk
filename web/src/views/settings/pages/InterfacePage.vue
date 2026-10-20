<template>
  <div class="settings-interface">
    <SettingsScope scope="Это устройство" />
    <p v-if="error" role="alert">{{ error }}</p>
    <SettingsField
      v-for="field in fields"
      :key="field.key"
      :address="field.address"
      :layout="field.resourceId === 'hotkeys' ? 'stack' : 'row'"
    >
      <template v-if="field.resourceId === 'wakeLock'">
        <UiSwitch
          v-if="loaded('wakeLock')"
          :aria-label="field.label"
          :model-value="wakeLockEnabled"
          :disabled="device.wakeLockBusy || (!device.wakeLockSupported && !wakeLockEnabled)"
          @update:model-value="settings.setField('wakeLock', 'enabled', $event)"
        />
        <p v-if="device.wakeLockActive">Экран удерживается включённым.</p>
        <p v-else-if="device.wakeLockError" role="status">{{ device.wakeLockError }}</p>
        <p v-else-if="!device.wakeLockSupported">Удержание экрана недоступно в этом браузере.</p>
      </template>
      <template v-else-if="field.key === 'notificationTest'">
        <UiButton
          :disabled="device.notificationBusy || !device.notificationSupported"
          @click="device.testNotification"
        >
          {{ device.notificationPermission === 'granted' ? 'Проверить' : 'Включить и проверить' }}
        </UiButton>
        <p v-if="device.notificationError" role="status">{{ device.notificationError }}</p>
        <p v-else-if="device.notificationPermission === 'granted'">
          Оповещения разрешены на этом устройстве.
        </p>
        <p v-else-if="!device.notificationSupported">Системные оповещения недоступны в этом браузере.</p>
      </template>
      <template v-else-if="loaded('hotkeys')">
        <div
          v-for="row in rows"
          :key="row.id"
          :data-hotkey-tool="row.id"
          class="settings-hotkey-row"
        >
          <span>
            {{ row.label }}
            <small v-if="row.availability === 'disabled'">· плагин выключен — клавиша молчит</small>
            <small v-else-if="row.availability === 'pending'">· состояние плагина ещё не получено</small>
          </span>
          <kbd class="settings-hotkey-combo" :data-recording="hotkeys.recording === row.id">
            {{ hotkeys.recording === row.id ? 'Нажмите сочетание…' : formatCombo(row.combo) || 'Выключено' }}
          </kbd>
          <div class="settings-hotkey-actions">
            <UiButton
              data-record
              :aria-label="`Изменить клавишу: ${row.label}`"
              @click="record(row.id)"
            >
              {{ hotkeys.recording === row.id ? 'Отменить' : 'Изменить' }}
            </UiButton>
            <UiButton @click="toggle(row.id, Boolean(row.combo))">
              {{ row.combo ? 'Выключить' : 'Вернуть' }}
            </UiButton>
          </div>
        </div>
        <p v-if="mapIssue" role="alert">{{ mapIssue }}</p>
        <p>Запись использует физическую клавишу. Комбинации системы и браузера недоступны.</p>
        <UiButton @click="settings.setField('hotkeys', 'overrides', {})">Вернуть стандартные</UiButton>
      </template>
    </SettingsField>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  UiButton,
  UiSwitch,
  getUiLayerDiagnostics,
  subscribeUiLayerDiagnostics,
} from '../../../ui.ts';
import { SETTINGS_FIELDS } from '../../../features/settings/catalog.ts';
import { createHotkeysAdapter, createWakeLockAdapter } from '../../../features/settings/resources/device.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import { useDeviceStore, WAKE_LOCK_KEY } from '../../../stores/device.js';
import {
  useHotkeysStore,
  validateHotkeyOverrides,
  DEFAULT_HOTKEYS,
  HOTKEYS_KEY,
} from '../../../stores/hotkeys.js';
import { usePluginsStore } from '../../../stores/plugins.js';
import { TOOL_CATALOG, toolAvailability } from '../../../shared/tools/catalog.ts';
import { comboFromEvent, formatCombo, isLayoutSwitch } from '../../../shared/hotkeys/combo.ts';
import { failureText } from '../../../shared/apiClient.ts';
import SettingsField from '../SettingsField.vue';
import SettingsScope from '../SettingsScope.vue';

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const device = useDeviceStore();
const hotkeys = useHotkeysStore();
const plugins = usePluginsStore();
const error = ref('');
const fields = computed(() => SETTINGS_FIELDS.filter((field) => field.address.pageId === settings.pageId));
const wakeLockEnabled = computed(() => {
  settings.snapshot;

  return settings.getValue('wakeLock', 'enabled') === true;
});
const overrides = computed(() => {
  settings.snapshot;

  return settings.getValue('hotkeys', 'overrides') as Record<string, string> | undefined ?? {};
});
const rows = computed(() => TOOL_CATALOG.map((tool) => ({
  id: tool.id,
  label: tool.label,
  availability: toolAvailability(tool, plugins),
  combo: Object.hasOwn(overrides.value, tool.id) ? overrides.value[tool.id] : DEFAULT_HOTKEYS[tool.id],
})));
const mapIssue = computed(() => {
  const result = validateHotkeyOverrides(overrides.value);

  return result.ok ? '' : result.error;
});
let stopLayers: (() => void) | undefined;

function loaded(id: string): boolean {
  return settings.snapshot.resources.some((resource) => resource.id === id && resource.loaded);
}

function record(id: string): void {
  error.value = '';

  if (hotkeys.recording === id) {
    hotkeys.stopRecording();
  } else {
    hotkeys.startRecording(id);
  }
}

/**
 * Выключение и возврат сочетания меняют только полную карту черновика.
 * Отсутствие ключа сохраняет отличие умолчания от явно выключенной строки.
 */
function toggle(id: string, enabled: boolean): void {
  const next = { ...overrides.value };

  hotkeys.stopRecording();

  if (enabled) {
    next[id] = '';
  } else {
    delete next[id];
  }

  settings.setField('hotkeys', 'overrides', next);
}

/**
 * Запись перехватывает Escape до document-стека и не меняет работающие привязки.
 * Конфликт итоговой карты виден сразу и может быть исправлен второй правкой до Apply.
 */
function onRecordKey(event: KeyboardEvent): void {
  if (!hotkeys.recording || event.isComposing) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  if (event.key === 'Escape') {
    hotkeys.stopRecording();

    return;
  }

  if (isLayoutSwitch(event)) {
    error.value = 'Сочетание забрал системный переключатель раскладки. Выберите сочетание с Ctrl.';

    return;
  }

  const combo = comboFromEvent(event);

  if (combo) {
    settings.setField('hotkeys', 'overrides', { ...overrides.value, [hotkeys.recording]: combo });
    hotkeys.stopRecording();
  }
}

/**
 * Обработчик другого окна остаётся живым после ухода со страницы ресурса.
 * Сессия принимает новый baseline, сохраняя собственную правку и отмечая конфликт.
 */
function bindStorage(resourceId: string): void {
  const opening = settings.snapshot.sessionId;

  settings.bindSession(resourceId, () => {
    /**
     * Событие другого окна обновляет текущую доменную проекцию без обратной записи.
     * Номер открытия защищает форму от позднего ответа захвата экрана.
     */
    const onStorage = async (event: StorageEvent) => {
      if (event.key === HOTKEYS_KEY && resourceId === 'hotkeys') {
        hotkeys.reload();
        settings.acceptSnapshot('hotkeys', { overrides: { ...hotkeys.overrides } }, opening);
      } else if (event.key === WAKE_LOCK_KEY && resourceId === 'wakeLock') {
        await device.reloadWakeLock();
        settings.acceptSnapshot('wakeLock', { enabled: device.wakeLockEnabled }, opening);
      }
    };

    window.addEventListener('storage', onStorage);

    return () => window.removeEventListener('storage', onStorage);
  });
}

/**
 * Загружается только ресурс выбранной страницы, разрешение уведомлений не запрашивается.
 * Поля и адаптер остаются в общей сессии после перехода к другой форме.
 */
async function load(): Promise<void> {
  hotkeys.stopRecording();

  if (!props.active || !settings.isOpen) {
    return;
  }

  const resourceId = settings.pageId === 'interface.behavior' ? 'wakeLock'
    : settings.pageId === 'interface.shortcuts' ? 'hotkeys' : '';

  if (!resourceId) {
    return;
  }

  const opening = settings.snapshot.sessionId;

  try {
    const adapter = resourceId === 'wakeLock' ? createWakeLockAdapter(device) : createHotkeysAdapter(hotkeys);

    settings.registerResource(adapter, SETTINGS_FIELDS.filter((field) => field.resourceId === resourceId));
    await settings.loadResource(resourceId);

    if (settings.isOpen && settings.snapshot.sessionId === opening) {
      bindStorage(resourceId);
    }
  } catch (cause) {
    error.value = failureText(cause);
  }
}

watch([() => props.active, () => settings.pageId], load, { immediate: true });
watch(() => settings.snapshot.applying, () => hotkeys.stopRecording());

onMounted(() => {
  window.addEventListener('keydown', onRecordKey, true);

  const original = new Set(getUiLayerDiagnostics().map((layer) => layer.id));

  stopLayers = subscribeUiLayerDiagnostics(() => {
    if (getUiLayerDiagnostics().some((layer) =>
      ['dialog', 'confirm'].includes(layer.kind) && !original.has(layer.id))) {
      hotkeys.stopRecording();
    }
  });
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onRecordKey, true);
  stopLayers?.();
  hotkeys.stopRecording();
});
</script>

<style scoped>
.settings-interface {
  display: grid;
  gap: 0;
  align-content: start;
  min-width: 0;
}
.settings-hotkey-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
}
.settings-hotkey-row:first-child {
  padding-top: 0;
}
.settings-hotkey-row small {
  display: block;
  margin-top: 4px;
  color: var(--ink-low);
  font-size: 11px;
}
.settings-hotkey-combo {
  justify-self: end;
  padding: 5px 8px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: var(--ground);
  color: var(--ink-mid);
  font: 11px var(--mono);
}
.settings-hotkey-combo[data-recording='true'] {
  border-color: var(--accent);
  color: var(--accent);
}
.settings-hotkey-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
@container settings-field (max-width: 620px) {
  .settings-hotkey-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .settings-hotkey-actions {
    grid-column: 1 / -1;
  }
}
</style>
