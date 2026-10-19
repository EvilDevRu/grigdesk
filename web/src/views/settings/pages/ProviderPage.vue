<template>
  <div
    class="settings-provider"
    :data-provider-page="selected?.id"
    :data-ready="ready"
  >
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="settings-provider-list">
      <section
        v-for="group in groups"
        :key="group.id"
        :data-executor-type="group.id"
      >
        <h4>{{ group.label }}</h4>
        <p>{{ group.hint }}</p>
        <UiButton
          v-for="entry in group.providers"
          :key="entry.id"
          :data-select-provider="entry.id"
          :aria-pressed="selected?.id === entry.id"
          @click="selectProvider(entry.id)"
        >
          {{ entry.name }} · {{ entry.available ? 'Доступен' : 'Недоступен' }}
          <span v-if="entry.updateAvailable">· Есть обновление</span>
          <span v-if="dirtyProvider(entry.id)">· Не применено</span>
        </UiButton>
      </section>
    </div>
    <div class="settings-provider-actions">
      <UiButton :disabled="refreshing" @click="refreshRegistry">Перепроверить</UiButton>
      <UiButton :disabled="checking" @click="checkUpdates">Проверить обновления</UiButton>
    </div>
    <template v-if="selected">
      <h4>{{ selected.name }}</h4>
      <UiTabs
        data-ui-workspace-tabs
        :model-value="tab"
        label="Параметры исполнителя"
        @update:model-value="selectTab"
      >
        <UiTab
          v-for="item in tabs"
          :key="item.id"
          :value="item.id"
        >
          {{ item.label }}
        </UiTab>
      </UiTabs>
      <p v-if="!ready">Загрузка…</p>
      <template v-else-if="tab === 'access'">
        <p>Все устройства · Ключи и режим доступа изменятся после «Применить».</p>
        <div v-for="field in visibleCredentials" :key="field.env">
          <SettingsField :address="fieldAddress('credentials', field.env)">
            <template v-if="field.kind === 'secret'">
              <UiPasswordInput
                :model-value="credentialText(field.env)"
                autocomplete="new-password"
                :aria-label="field.label"
                :placeholder="credentialPlaceholder(field)"
                @update:model-value="editCredential(field.env, $event)"
              />
              <p v-if="field.set && field.inFile === false">Ключ задан вне файла настроек службы.</p>
              <UiButton
                v-if="field.inFile === true"
                data-delete-key
                @click="deleteKey(field)"
              >
                Удалить ключ
              </UiButton>
              <p v-if="secretRemoval(field.env)">Ключ будет удалён после «Применить».</p>
            </template>
            <UiSegmentedControl
              v-else-if="(field.options?.length ?? 0) <= 4"
              :model-value="credentialText(field.env)"
              :options="field.options"
              :label="field.label"
              @update:model-value="editCredential(field.env, $event)"
            />
            <UiSelect
              v-else
              :model-value="credentialText(field.env)"
              :aria-label="field.label"
              @update:model-value="editCredential(field.env, $event)"
            >
              <option
                v-for="option in field.options"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </UiSelect>
            <p v-if="field.kind === 'choice'">
              {{ field.options?.find((item) => item.value === credentialText(field.env))?.hint }}
            </p>
          </SettingsField>
        </div>
        <div v-for="field in hiddenCredentialDrafts" :key="field.env">
          <SettingsField :address="fieldAddress('credentials', field.env)">
            <p>Поле скрыто выбранным режимом. Вернитесь к нему или отмените неприменённую правку.</p>
            <UiButton @click="settings.discardField(credentialsId, field.env)">Отменить правку</UiButton>
          </SettingsField>
        </div>
        <p v-if="!selected.credentials?.length">У этого исполнителя нет редактируемых ключей доступа.</p>
      </template>
      <template v-else-if="ready && tab === 'parameters'">
        <p>Для следующих запусков · Изменения сохранятся по «Применить».</p>
        <SettingsField
          v-for="field in selected.settings ?? []"
          :key="field.id"
          :address="fieldAddress('settings', field.id)"
          :data-ordinary="field.id"
        >
          <UiSwitch
            v-if="field.kind === 'toggle'"
            :model-value="ordinaryValue(field.id) === true"
            :disabled="field.disabled || confirming === field.id"
            :aria-label="field.label"
            @update:model-value="editOrdinary(field, $event)"
          />
          <UiInput
            v-else-if="field.kind === 'text'"
            :model-value="String(ordinaryValue(field.id) ?? '')"
            :disabled="field.disabled"
            :aria-label="field.label"
            @update:model-value="editOrdinary(field, $event)"
          />
          <UiRange
            v-else-if="field.kind === 'range' && typeof field.max === 'number'"
            :model-value="Number(ordinaryNumber(field.id))"
            :min="field.min ?? 0"
            :max="field.max"
            :step="field.step ?? 1"
            :disabled="field.disabled"
            :aria-label="field.label"
            @update:model-value="editOrdinary(field, $event)"
          />
          <UiNumberInput
            v-else
            :model-value="ordinaryNumber(field.id)"
            :min="field.min"
            :max="field.max"
            :step="field.step ?? 'any'"
            :disabled="field.disabled"
            :aria-label="field.label"
            @update:model-value="editOrdinary(field, $event)"
          />
          <p v-if="field.note">{{ field.note }}</p>
        </SettingsField>
        <template v-if="selected.settingsCatalog">
          <UiDisclosureButton v-model:open="showNative" :controls="nativePanelId">
            Дополнительные параметры
          </UiDisclosureButton>
          <section
            v-if="showNative"
            :id="nativePanelId"
            class="settings-native-panel"
          >
            <p v-if="nativeState.loading">Загрузка каталога…</p>
            <p v-if="nativeState.error" role="alert">{{ nativeState.error }}</p>
            <template v-if="nativeState.catalog">
              <p>{{ nativeState.catalog.scope.label }} · Сохранение для следующего запуска.</p>
              <UiInput
                v-model="nativeQuery"
                type="search"
                aria-label="Найти дополнительный параметр"
              />
              <UiButton :disabled="nativeState.loading" @click="reloadNative">Перепроверить каталог</UiButton>
              <SettingsNativeEditor
                v-for="field in nativeView.editable"
                :key="field.id"
                :field="field"
                :provider-id="selected.id"
                :expand="Boolean(nativeQuery)"
              />
              <p v-if="!nativeView.editableCount">Нет доступных параметров по этому запросу.</p>
              <SettingsField
                v-for="field in nativeState.catalog.inactiveOverrides"
                :key="field.id"
                :address="fieldAddress('native', field.path)"
              >
                <p>{{ field.reason }}</p>
                <UiButton @click="settings.unsetField(nativeId, field.id)">Удалить выбор</UiButton>
              </SettingsField>
            </template>
          </section>
        </template>
      </template>
      <template v-else-if="ready && tab === 'overview'">
        <p>{{ selected.vendor }} · {{ selected.kind === 'api' ? 'API' : 'CLI' }} · {{ selected.version }}</p>
        <p>{{ selected.authLabel }}</p>
        <p v-if="normalizeExecutorType(selected.type) === 'universal' && selected.chatEnabled === false">
          Установка доступна; подключение к чатам пока не включено.
        </p>
        <p v-if="selected.distribution">
          {{ selected.distribution.label }} ·
          {{ selected.distribution.ready ? 'Сборка готова' : 'Сборка недоступна' }}
        </p>
        <p v-if="selected.distribution?.authHint && selected.installed && !selected.available">
          Авторизация: {{ selected.distribution.authHint }}
        </p>
        <div v-if="selected.distribution?.problem && !selected.distribution.ready">
          <p>{{ selected.distribution.problem.message }}</p>
          <UiCommandButton
            v-if="selected.distribution.problem.command"
            @click="terminal(selected.distribution.problem.command)"
          >
            {{ selected.distribution.problem.command }}
          </UiCommandButton>
        </div>
        <UiCommandButton
          v-if="!selected.available && (selected.setupCommand || selected.install)"
          @click="terminal(selected.setupCommand || selected.install || '')"
        >
          {{ selected.installed ? 'Авторизация' : 'Установка' }}:
          {{ selected.setupCommand || selected.install }}
        </UiCommandButton>
        <section v-if="resources.length" data-provider-usage>
          <h4>Ресурсы исполнителя</h4>
          <ProviderUsageResources :provider-id="selected.id" :resources="resources" />
        </section>
        <UiButton
          v-if="selected.installed && selected.canUpdate"
          :disabled="Boolean(providers.updating)"
          @click="providers.updateCli(selected.id)"
        >
          Обновить CLI
        </UiButton>
        <p v-if="updateResult">{{ updateResult.text }}</p>
      </template>
      <template v-else-if="ready && tab === 'models'">
        <p>Каталог исполнителя · Только чтение. Общая видимость задаётся на странице «Модели».</p>
        <p v-for="model in selected.models ?? []" :key="model.id">
          {{ model.name }} · {{ model.id }}
          <span v-if="model.extra || model.hidden">· Скрыта из краткого списка</span>
          <span v-if="model.unknown">· Неизвестна CLI</span>
          <span v-if="model.efforts?.length">· Усилие: {{ model.efforts.join(', ') }}</span>
        </p>
      </template>
      <ProviderMcpStatus
        v-else-if="ready && tab === 'mcp' && selected.mcp && selected.installed"
        :provider-id="selected.id"
        :provider-name="selected.name"
        :status="mcpStatus"
        @refresh="providers.loadMcp(selected.id, true)"
      />
      <p v-else-if="ready">Исполнитель не объявил эту возможность.</p>
    </template>
    <p v-else-if="settings.entityId">Исполнитель больше недоступен в реестре.</p>
    <div v-for="item in orphaned" :key="`${item.resourceId}:${item.field.key}`">
      <SettingsField :address="item.field.address">
        <p>{{ item.field.unavailable }}</p>
        <UiButton
          v-if="item.resourceId === nativeId"
          @click="settings.unsetField(item.resourceId, item.field.key)"
        >
          Сбросить
        </UiButton>
        <UiButton @click="settings.discardField(item.resourceId, item.field.key)">Отменить правку</UiButton>
      </SettingsField>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import {
  UiTabs,
  UiTab,
  UiSwitch,
  UiInput,
  UiSelect,
  UiNumberInput,
  UiRange,
  UiPasswordInput,
  UiButton,
  UiDisclosureButton,
  UiSegmentedControl,
  UiCommandButton,
  confirmDialog,
} from '../../../ui.ts';
import type { ProviderSettingNode, JsonValue } from '../../../../../shared/chat/providerSettingsContracts.ts';
import type {
  ProviderEntry,
  ProviderCredentialEntry,
  ProviderSettingEntry,
} from '../../../../../shared/chat/providersContracts.ts';
import { useSettingsStore } from '../../../stores/settings.ts';
import { useProvidersStore } from '../../../stores/providers.js';
import { useProviderSettingsStore } from '../../../stores/providerSettings.ts';
import { createProviderEditor } from '../../../features/settings/providerEditor.ts';
import {
  credentialVisible,
  nativeLeaves,
  type ProviderStorePort,
} from '../../../features/settings/resources/providers.ts';
import { nativeSettingsFields } from '../nativeSettingsFields.ts';
import { executorTypeGroups, normalizeExecutorType } from '../../../../../shared/chat/executorTypes.ts';
import { createSettingsActions } from '../../../features/settings/actions.ts';
import { useToolLauncher } from '../../../shared/tools/launcher.ts';
import ProviderMcpStatus from '../ProviderMcpStatus.vue';
import ProviderUsageResources from '../../../features/providers/ProviderUsageResources.vue';
import { api, failureText } from '../../../shared/apiClient.ts';
import type { FieldAddress } from '../../../features/settings/contracts.ts';
import SettingsField from '../SettingsField.vue';
import SettingsNativeEditor from './SettingsNativeEditor.vue';

const props = defineProps<{ active: boolean }>();
const settings = useSettingsStore();
const providers = useProvidersStore();
const native = useProviderSettingsStore();
const registry = computed(() => providers.providers as ProviderEntry[]);
const selected = computed(() => registry.value.find((entry) => entry.id === settings.entityId));
const ready = ref(false);
const showNative = ref(false);
const nativeQuery = ref('');
const error = ref('');
const refreshing = ref(false);
const checking = ref(false);
const groups = computed(() => executorTypeGroups(registry.value));
const launcher = useToolLauncher();
const actions = createSettingsActions({
  requestAction: settings.requestAction,
  notify: (text) => {
    error.value = text;
  },
  openTerminal: launcher.openTerminal,
  openChat: async () => false,
});
const resources = computed(() => (providers.usage as Record<string, { resources?: unknown[] }>)[
  settings.entityId ?? ''
]?.resources ?? []);
const updateResult = computed(() => (providers.updateResults as Record<string, { text: string }>)[
  settings.entityId ?? ''
]);
const mcpStatus = computed(() => (providers.mcp as Record<string,
  InstanceType<typeof ProviderMcpStatus>['$props']['status']>)[settings.entityId ?? ''] ?? null);
const confirming = ref('');
const nativePanelId = `settings-native-${useId()}`;
const tab = computed(() => settings.tabId ?? 'overview');
const credentialsId = computed(() => `providerCredentials:${settings.entityId}`);
const ordinaryId = computed(() => `providerSettings:${settings.entityId}`);
const nativeId = computed(() => `providerNative:${settings.entityId}`);
const nativeState = computed(() => native.panel(settings.entityId ?? ''));
const tabs = [
  { id: 'overview', label: 'Обзор' },
  { id: 'access', label: 'Доступ' },
  { id: 'parameters', label: 'Параметры' },
  { id: 'models', label: 'Модели' },
  { id: 'mcp', label: 'MCP' },
];
let editor: ReturnType<typeof createProviderEditor> | null = null;

const credentialChoices = computed(() => Object.fromEntries((selected.value?.credentials ?? [])
  .filter((field) => field.kind === 'choice').map((field) => [field.env, credentialText(field.env)])));
const visibleCredentials = computed(() => (selected.value?.credentials ?? [])
  .filter((field) => credentialVisible(field, credentialChoices.value)));
const hiddenCredentialDrafts = computed(() => (selected.value?.credentials ?? [])
  .filter((field) => !credentialVisible(field, credentialChoices.value)
    && settings.snapshot.resources.find((resource) => resource.id === credentialsId.value)
      ?.fields.some((item) => item.key === field.env && item.dirty)));
const nativeView = computed(() => {
  const state = settings.snapshot.resources.find((resource) => resource.id === nativeId.value);
  const drafts = Object.fromEntries((state?.fields ?? []).filter((field) => field.intent?.op === 'set')
    .map((field) => [field.key, field.intent?.op === 'set' ? field.intent.value : null]));
  const errors = Object.fromEntries((state?.fields ?? []).filter((field) => field.error)
    .map((field) => [field.key, field.error!]));
  const catalog = nativeState.value.catalog;
  const available = Boolean(catalog && ['ready', 'partial'].includes(catalog.state)
    && catalog.schemaRevision !== null);

  return nativeSettingsFields(
    projectNative(catalog?.fields ?? [], available), nativeQuery.value, drafts, errors,
  );
});
const orphaned = computed(() => {
  const knownOrdinary = new Set(selected.value?.settings?.map((field) => field.id));
  const knownCredentials = new Set(selected.value?.credentials?.map((field) => field.env));
  const catalog = nativeState.value.catalog;
  const knownNative = new Set([
    ...nativeLeaves(catalog?.fields ?? []).map((field) => field.id),
    ...catalog?.inactiveOverrides.map((field) => field.id) ?? [],
  ]);

  return settings.snapshot.resources.flatMap((resource) => resource.fields.filter((field) =>
    field.address.entityId === settings.entityId && field.dirty && field.unavailable
    && !(resource.id === ordinaryId.value ? knownOrdinary : resource.id === credentialsId.value
      ? knownCredentials : knownNative).has(field.key)).map((field) => ({ resourceId: resource.id, field })));
});

function selectProvider(id: string): void {
  settings.selectPage('agents.providers', id, tab.value);
}

function dirtyProvider(id: string): boolean {
  return settings.snapshot.resources.some((resource) => resource.fields.some((field) =>
    field.address.entityId === id && field.dirty));
}

function terminal(command: string): void {
  void actions.openTerminal(command);
}

/**
 * Проверка реестра не применяет параметры формы и не сбрасывает её intents.
 * Ошибка остаётся рядом с операцией, а флаг занятости снимается при любом исходе.
 */
async function refreshRegistry(): Promise<void> {
  refreshing.value = true;

  try {
    if (editor) {
      await editor.refresh();
    } else {
      await providers.load(true);
    }
  } catch (cause) {
    error.value = failureText(cause);
  } finally {
    refreshing.value = false;
  }
}

/**
 * Проверка версий является отдельной немедленной операцией, а не Apply.
 * Актуальные capability и индикаторы приходят из общего реестра после ответа.
 */
async function checkUpdates(): Promise<void> {
  checking.value = true;

  try {
    await api.post('/api/providers/check-updates', {});
    await refreshRegistry();
  } catch (cause) {
    error.value = failureText(cause);
  } finally {
    checking.value = false;
  }
}

/**
 * Недоступный источник не открывает новые controls из последней схемы.
 * Сохранённый выбор, dirty и ошибка остаются видимыми с действием сброса.
 */
function projectNative(fields: ProviderSettingNode[], available: boolean): ProviderSettingNode[] {
  return fields.map((field) => ({
    ...field,
    writable: field.writable && available,
    ...field.children ? { children: projectNative(field.children, available) } : {},
  }));
}

/**
 * Адрес хранит исходные сегменты ключа без разбора точек и слешей.
 * Подвкладка определяется ресурсом, а entity остаётся выбранным исполнителем.
 */
function fieldAddress(section: string, key: string | string[]): FieldAddress {
  return {
    pageId: 'agents.providers',
    entityId: settings.entityId,
    tabId: section === 'credentials' ? 'access' : 'parameters',
    fieldPath: [section, ...Array.isArray(key) ? key : [key]],
  };
}

function selectTab(value: string | number): void {
  settings.selectPage('agents.providers', settings.entityId, String(value));
}

function ordinaryValue(key: string): JsonValue | undefined {
  settings.snapshot;

  return settings.getValue(ordinaryId.value, key);
}

function ordinaryNumber(key: string): number | '' {
  const value = ordinaryValue(key);

  return typeof value === 'number' ? value : '';
}

/**
 * Подтверждение относится к конкретному изменению черновика, а не повторяется при Apply.
 * Возврат к baseline не запрашивает согласие и снимает confirmed через сессию.
 */
async function editOrdinary(field: ProviderSettingEntry, value: JsonValue): Promise<void> {
  const opening = settings.snapshot.sessionId;
  const resourceId = ordinaryId.value;
  const baseline = settings.getBaseline(resourceId)[field.id];
  const confirmation = value ? field.confirm?.on : field.confirm?.off;
  let confirmed: true | undefined;

  if (JSON.stringify(value) !== JSON.stringify(baseline) && confirmation) {
    confirming.value = field.id;

    const accepted = await confirmDialog(confirmation.text, {
      okText: confirmation.label ?? field.label,
      danger: confirmation.danger === true,
    });

    confirming.value = '';

    if (!accepted) {
      return;
    }

    confirmed = true;
  }

  if (settings.isOpen && settings.snapshot.sessionId === opening && !settings.snapshot.applying) {
    settings.setField(resourceId, field.id, value, confirmed);
  }
}

function credentialText(key: string): string {
  settings.snapshot;

  return String(settings.getValue(credentialsId.value, key) ?? '');
}

function editCredential(key: string, value: unknown): void {
  const field = selected.value?.credentials?.find((entry) => entry.env === key);

  if (field?.kind === 'secret' && value === '') {
    settings.discardField(credentialsId.value, key);
  } else {
    settings.setField(credentialsId.value, key, String(value ?? ''));
  }
}

/**
 * Подсказка показывает только короткую серверную маску.
 * Даже при некорректном DTO полное сохранённое значение не выводится.
 */
function credentialPlaceholder(field: ProviderCredentialEntry): string {
  const preview = field.preview?.startsWith('…') && field.preview.length <= 8 ? field.preview : '';

  return field.set ? `Задан ${preview}; пусто — не менять` : 'Введите ключ';
}

function secretRemoval(key: string): boolean {
  settings.snapshot;

  return settings.getIntent(credentialsId.value, key)?.op === 'set'
    && settings.getValue(credentialsId.value, key) === null;
}

/**
 * Удаление ключа — подтверждённое намерение null, сетевой вызов остаётся у Apply.
 * Позднее согласие закрытого открытия не восстанавливает секретный черновик.
 */
async function deleteKey(field: ProviderCredentialEntry): Promise<void> {
  const opening = settings.snapshot.sessionId;
  const resourceId = credentialsId.value;
  const accepted = await confirmDialog('Ключ будет удалён после «Применить»', {
    okText: 'Удалить после применения',
    danger: true,
  });

  if (accepted && settings.isOpen && settings.snapshot.sessionId === opening && !settings.snapshot.applying) {
    settings.setField(resourceId, field.env, null, true);
  }
}

/**
 * Перепроверка обновляет каталог, не сохраняя черновик формы.
 * Отказ чтения остаётся видимым на странице без unhandled rejection.
 */
async function reloadNative(): Promise<void> {
  try {
    await editor?.loadNative(true);
  } catch (cause) {
    error.value = failureText(cause);
  }
}

/**
 * Выбранный ресурс загружается лениво; смена вкладки не пересоздаёт его адаптер.
 * Открытие закрытой сессии не запускает чтение и не восстанавливает прежний ввод.
 */
async function load(): Promise<void> {
  if (!props.active || !settings.isOpen || settings.pageId !== 'agents.providers') {
    return;
  }

  if (!providers.loaded) {
    await providers.load();
  }
  if (!settings.entityId) {
    if (registry.value[0] && !settings.navigationError) {
      settings.selectPage('agents.providers', registry.value[0].id, settings.tabId);
    }

    return;
  }
  if (!selected.value) {
    ready.value = false;

    return;
  }

  const id = selected.value.id;
  const opening = settings.snapshot.sessionId;

  ready.value = false;
  editor = settings.sessionService(`provider-editor:${id}`, () =>
    createProviderEditor(id, settings, providers as unknown as ProviderStorePort, native));

  try {
    if (tab.value === 'overview') {
      await providers.loadUsage();
    } else if (tab.value === 'mcp' && selected.value?.mcp && selected.value.installed) {
      await providers.loadMcp(id);
    } else if (tab.value === 'access') {
      await editor.loadAccess();
    } else if (tab.value === 'parameters') {
      await editor.loadParameters();

      if (settings.revealTarget?.entityId === id
          && ['native', 'native-catalog'].includes(settings.revealTarget.fieldPath[0] ?? '')) {
        showNative.value = true;
        nativeQuery.value = '';
        await editor.loadNative();
      }
    }

    if (settings.isOpen && settings.entityId === id && settings.snapshot.sessionId === opening) {
      ready.value = true;

      if (settings.revealTarget?.fieldPath[0] === 'native-catalog') {
        settings.revealTarget = null;
      }
    }
  } catch (cause) {
    error.value = failureText(cause);
  }
}

watch([() => props.active, () => settings.isOpen, () => providers.providers], () => {
  if (props.active && settings.isOpen) {
    for (const entry of registry.value) {
      settings.sessionService(`provider-editor:${entry.id}`, () =>
        createProviderEditor(entry.id, settings, providers as unknown as ProviderStorePort, native));
    }
  }
}, { immediate: true });
watch([() => props.active, () => settings.pageId, () => settings.entityId,
  () => settings.tabId, () => settings.snapshot.sessionId,
], load, { immediate: true });
watch(() => settings.entityId, () => {
  showNative.value = false;
  nativeQuery.value = '';
});
watch(() => settings.revealTarget, (target) => {
  if (target && target.entityId === settings.entityId && tab.value === 'parameters'
      && ['native', 'native-catalog'].includes(target.fieldPath[0] ?? '')) {
    void load();
  }
});
watch(showNative, async (open) => {
  if (open && props.active && tab.value === 'parameters') {
    try {
      await editor?.loadNative();
    } catch (cause) {
      error.value = failureText(cause);
    }
  }
});
</script>

<style scoped>
.settings-provider-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.settings-provider h4, .settings-provider p { margin: 0; }
.settings-provider-list section { display: grid; gap: 8px; }
.settings-provider-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.settings-provider { display: grid; gap: 12px; min-width: 0; align-content: start; }
.settings-native-panel { display: grid; gap: 20px; min-width: 0; }
@media (max-width: 900px) {
  .settings-provider-list { grid-template-columns: minmax(0, 1fr); }
}
</style>
