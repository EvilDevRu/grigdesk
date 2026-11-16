<template>
  <TrackerInstallDialog v-if="!connectionOpen" :open="open" :request="installRequest"
                        @update:open="emit('update:open', $event)" @configure="configureDriver" />
  <UiDialog v-else :open="open" :title="t('core.trackerDriversTitle')" :busy="busy" :dismissible="!busy"
            data-role="tracker-settings" data-ui-workspace
            initial-focus="[data-driver][aria-pressed='true'], #tracker-driver"
            @update:open="emit('update:open', $event)">
    <template #title>
      <div class="tracker-settings__heading">
        <span class="tracker-settings__title">{{ t('core.trackerDriversTitle') }}</span>
        <UiIconButton :label="t('core.close')" :disabled="busy" @click="emit('update:open', false)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </UiIconButton>
      </div>
    </template>

    <div class="tracker-settings" :aria-busy="loading || busy">
      <UiLoadingState v-if="loading">
        <div class="tracker-settings__workspace" aria-hidden="true" data-loading-region="tracker-settings">
          <div class="tracker-settings__sidebar">
            <div class="tracker-settings__picker">
              <div class="tracker-settings__loading-field">
                <UiSkeleton width="120px" height="18px" />
                <UiSkeleton shape="block" height="var(--control-height)" />
              </div>
            </div>
            <div class="tracker-settings__catalog">
              <h3><UiSkeleton width="65%" height="18px" /></h3>
              <div v-for="index in externalDrivers.length || 3" :key="index"
                   class="tracker-settings__loading-driver">
                <UiSkeleton width="72%" height="18px" />
                <UiSkeleton width="30%" height="14px" />
              </div>
            </div>
            <div class="tracker-settings__catalog-actions">
              <UiSkeleton shape="block" height="var(--control-height)" width="min(100%, 180px)" />
              <UiSkeleton shape="block" height="var(--control-height)" width="min(100%, 140px)" />
            </div>
          </div>
          <div class="tracker-settings__editor">
            <div class="tracker-settings__driver-heading">
              <UiSkeleton width="45%" height="24px" />
              <UiSkeleton width="80px" height="18px" />
            </div>
            <UiSkeleton width="60%" height="18px" />
            <UiFormActions align="start">
              <UiSkeleton shape="block" width="100px" height="var(--control-height)" />
              <UiSkeleton shape="block" width="140px" height="var(--control-height)" />
            </UiFormActions>
            <div class="tracker-settings__section">
              <h4><UiSkeleton width="min(100%, 200px)" height="21px" /></h4>
              <UiFormActions align="start">
                <UiSkeleton shape="block" width="140px" height="var(--control-height)" />
                <UiSkeleton width="90px" height="var(--control-height)" />
              </UiFormActions>
              <div class="tracker-settings__fields">
                <div v-for="index in 3" :key="index" class="tracker-settings__loading-field">
                  <UiSkeleton width="35%" height="18px" />
                  <UiSkeleton shape="block" height="var(--control-height)" />
                </div>
              </div>
              <UiSkeleton shape="block" width="min(100%, 190px)" height="var(--control-height)" />
            </div>
          </div>
        </div>
      </UiLoadingState>
      <div v-else class="tracker-settings__workspace">
        <aside class="tracker-settings__sidebar" :aria-label="t('core.trackerInstalled')">
          <div class="tracker-settings__picker">
            <UiField id="tracker-driver" :label="t('core.trackerExternal')">
              <UiSelect v-model="editorId" :disabled="busy">
                <option v-if="!externalDrivers.length" value="">{{ t('core.trackerNone') }}</option>
                <option v-for="driver in externalDrivers" :key="driver.id" :value="driver.id">
                  {{ driver.name }}{{ savedEnabledIds.includes(driver.id)
                    ? t('core.taskTrackerenabled', { trackerEnabled: t('core.trackerEnabled') }) : '' }}{{ savedDefaultId === driver.id
                    ? t('core.taskTrackerinuse', { trackerInUse: t('core.trackerInUse') }) : '' }}
                </option>
              </UiSelect>
            </UiField>
          </div>
          <div class="tracker-settings__catalog">
            <h3>{{ t('core.trackerInstalled') }}</h3>
            <UiButton v-for="driver in externalDrivers" :key="driver.id" :data-driver="driver.id"
                      :pressed="editorId === driver.id" :disabled="busy" data-ui-settings-catalog
                      data-context="provider-entry" @click="editorId = driver.id">
              <span class="ui-settings-catalog-copy">
                <span class="ui-settings-catalog-heading">
                  <span class="ui-settings-catalog-title">{{ driver.name }}</span>
                  <span v-if="savedEnabledIds.includes(driver.id)" class="ui-status-chip"
                        data-tone="success" data-role="tracker-enabled">{{ t('core.trackerEnabled') }}</span>
                  <span v-if="savedDefaultId === driver.id" class="ui-status-chip"
                        data-role="tracker-in-use">{{ t('core.trackerInUse') }}</span>
                </span>
                <span class="ui-settings-catalog-status">
                  {{ installer.installed[driver.id]?.version || driver.version || '' }}
                  <span v-if="installer.installed[driver.id]?.updateAvailable">
                    · {{ t('core.trackerUpdates') }}
                  </span>
                </span>
              </span>
            </UiButton>
          </div>
          <div class="tracker-settings__catalog-actions">
            <UiButton :loading="checking" :disabled="packageActionsDisabled || !externalDrivers.length"
                      @click="checkUpdates()">{{ t('core.trackerCheckUpdates') }}</UiButton>
            <UiButton :disabled="busy || checking" @click="openInstaller()">
              {{ t('core.trackerAdd') }}
            </UiButton>
          </div>
        </aside>

        <section class="tracker-settings__editor" :aria-label="t('core.trackerDriverParameters')">
          <template v-if="selected">
            <div class="tracker-settings__driver-heading">
              <h3>{{ selected.name }}</h3>
              <span v-if="savedEnabledIds.includes(selected.id)" class="ui-status-chip"
                    data-tone="success" data-role="tracker-editor-enabled">{{ t('core.trackerEnabled') }}</span>
              <span v-if="savedDefaultId === selected.id" class="ui-status-chip"
                    data-role="tracker-editor-in-use">{{ t('core.trackerInUse') }}</span>
              <span v-if="packageInfo?.version || selected.version" class="tracker-settings__version">
                {{ t('core.trackerInstalledVersion', { version: packageInfo?.version || selected.version || '' }) }}
              </span>
            </div>
            <UiLoadingState v-if="updatesLoading" variant="inline" />
            <template v-else>
              <TrackerUpdateStatus :record="packageInfo" />
              <p v-if="!packageInfo && !updatesError" class="tracker-settings__note">
                {{ t('core.trackerUnmanaged') }}
              </p>
              <UiInlineMessage v-if="packageInfo?.localChanges" tone="warning">
                {{ t('core.trackerLocalChanges') }}
              </UiInlineMessage>
              <UiInlineMessage v-if="selected.status === 'restartRequired' || packageInfo?.restartRequired">
                {{ t('core.trackerRestart') }}
              </UiInlineMessage>
              <UiInlineMessage v-else-if="selected.reason" tone="warning">{{ selected.reason }}</UiInlineMessage>
            </template>
            <UiFormActions align="start">
              <UiButton :disabled="packageActionsDisabled || !packageInfo?.updateAvailable || packageInfo.localChanges"
                        @click="openUpdate()">{{ t('core.trackerUpdate') }}</UiButton>
              <UiButton v-if="packageInfo && !packageInfo.localChanges"
                        :disabled="packageActionsDisabled" @click="openPackageAction('version')">
                {{ t('core.trackerOtherVersion') }}
              </UiButton>
              <UiButton v-if="packageInfo?.rollbackAvailable && !packageInfo.localChanges"
                        :disabled="packageActionsDisabled" @click="openPackageAction('rollback')">
                {{ t('core.trackerRollback') }}
              </UiButton>
              <UiButton v-if="packageInfo?.localChanges"
                        :disabled="packageActionsDisabled" @click="openPackageAction('restore')">
                {{ t('core.trackerRestorePackage') }}
              </UiButton>
              <UiButton tone="danger" variant="solid" :disabled="packageActionsDisabled"
                        @click="removeSelected()">{{ t('core.trackerRemove') }}</UiButton>
            </UiFormActions>

            <section class="tracker-settings__section" :aria-label="t('core.trackerConnectionSettings')">
              <h4>{{ t('core.trackerConnectionSettings') }}</h4>
              <UiFormActions align="start">
                <UiButton :pressed="externalId === editorId" data-role="tracker-make-default"
                          :disabled="busy || !driverAvailable || externalId === editorId"
                          @click="makeDefault()">
                  {{ t('core.trackerInUse') }}
                </UiButton>
                <UiCheckbox :model-value="enabledIds.includes(editorId)" data-role="tracker-board-enabled"
                            :disabled="busy || (!driverAvailable && !enabledIds.includes(editorId))"
                            @update:model-value="setEnabled(Boolean($event))">
                  {{ t('core.trackerUseOnBoard') }}
                </UiCheckbox>
              </UiFormActions>
              <UiInlineMessage v-if="externalId !== (trackers.catalog?.externalId ?? '')">
                {{ externalId ? t('core.trackerSwitchConnection', { name: activeDriverName })
                  : t('core.trackerDisconnectConnection') }}
              </UiInlineMessage>
              <div class="tracker-settings__fields">
                <template v-for="(field, key) in selected.schema ?? {}" :key="key">
                  <UiField v-if="fieldVisible(field)" :label="fieldLabel(field.label, key)"
                           :hint="fieldHint(field)" :error="fieldError(String(key))">
                    <UiCheckbox v-if="field.type === 'boolean'" v-model="values[key]" :disabled="busy" />
                    <UiSelect v-else-if="field.type === 'select'" :model-value="String(values[key] ?? '')"
                              :disabled="busy" @update:model-value="values[key] = $event ?? ''">
                      <option value="" disabled>{{ t('core.trackerChooseOption') }}</option>
                      <option v-for="option in field.options" :key="option.value" :value="option.value">
                        {{ fieldLabel(option.label, option.value) }}
                      </option>
                    </UiSelect>
                    <UiInput v-else :model-value="String(values[key] ?? '')"
                             :type="field.secret ? 'password' : 'text'"
                             @update:model-value="
                               values[key] = field.type === 'number' ? Number($event) : ($event ?? '')
                             "
                             @blur="normalizePortalField(String(key), field)"
                             :disabled="busy" autocomplete="off" />
                  </UiField>
                </template>
              </div>
              <UiFormActions align="start">
                <UiButton :loading="testing" :disabled="busy || !driverAvailable || invalidTokenInput"
                          data-role="tracker-test-connection" aria-describedby="tracker-connection-hint"
                          @click="checkConnection()">
                  {{ t('core.trackerTestConnection') }}
                </UiButton>
                <span id="tracker-connection-hint" class="tracker-settings__note tracker-settings__connection-hint">
                  {{ t('core.trackerTestConnectionHint') }}
                </span>
              </UiFormActions>
              <UiInlineMessage v-if="connectionResult" :tone="connectionResult.ok ? 'success' : 'danger'"
                               role="status" data-role="tracker-connection-result">
                {{ connectionResult.ok ? t('core.trackerConnectionSuccess', { name: selected.name })
                  : t('core.trackerConnectionFailure', { name: selected.name }) }}
                <span v-if="connectionResult.error"> {{ connectionResult.error }}</span>
              </UiInlineMessage>
            </section>
          </template>
          <p v-else class="tracker-settings__note">{{ t('core.trackerEmpty') }}</p>
          <UiInlineMessage v-if="removalNeedsRefresh" tone="warning" role="status">
            {{ installer.unknownOutcome ? t('core.trackerCheckingOutcome') : t('core.trackerRefreshFailed') }}
            {{ installer.refreshError || installer.error }}
            <UiButton variant="link" :loading="recoveringRemoval" :disabled="busy" @click="recoverRemoval()">
              {{ t('core.trackerRefresh') }}
            </UiButton>
          </UiInlineMessage>
          <UiButton v-if="operationPending" :disabled="busy" @click="openOperation({ kind: 'resume' })">
            {{ t('core.trackerCheckingOutcome') }}
          </UiButton>
          <UiInlineMessage v-if="updatesError" tone="warning">
            {{ updatesError }}
            <UiButton variant="link" :disabled="updatesLoading || checking" @click="loadPackageInfo()">
              {{ t('core.trackerRefresh') }}
            </UiButton>
          </UiInlineMessage>
          <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
          <UiInlineMessage v-else-if="saved" tone="success" role="status">
            {{ t('core.trackerSaved') }}
          </UiInlineMessage>
        </section>
      </div>
    </div>

    <template #footer>
      <UiFormActions class="tracker-settings__actions">
        <UiButton variant="ghost" :disabled="busy" @click="emit('update:open', false)">
          {{ t('core.close') }}
        </UiButton>
        <UiButton :loading="saving === 'apply'"
                  :disabled="busy || loading || invalidTokenInput || removalNeedsRefresh" @click="save(false)">
          {{ t('core.trackerApply') }}
        </UiButton>
        <UiButton variant="solid" tone="accent" :loading="saving === 'save'"
                  :disabled="busy || loading || invalidTokenInput || removalNeedsRefresh" @click="save(true)">
          {{ t('core.trackerSave') }}
        </UiButton>
      </UiFormActions>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import type { TrackerLabel, TrackerSettingsField } from '../../../../shared/trackers/contracts.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';
import {
  isTrackerTokenField, isTrackerTokenInput, normalizeTrackerPortalInput, visibleTrackerTokenKeys,
} from '../../../../shared/trackers/settingsValidation.ts';
import { useTrackersStore } from '../../stores/trackers.ts';
import { useDriverInstallStore } from '../../stores/driverInstall.ts';
import type { DriverInstallRequest } from '../../stores/driverInstall.ts';
import { api, ApiError, failureText } from '../../shared/apiClient.ts';
import {
  t, resolveUiText, messageRef, UiButton, UiCheckbox, UiDialog, UiField, UiFormActions,
  UiIconButton, UiInlineMessage, UiInput, UiLoadingState, UiSelect, UiSkeleton,
} from '../../ui.ts';
import TrackerInstallDialog from './TrackerInstallDialog.vue';
import TrackerUpdateStatus from './TrackerUpdateStatus.vue';

defineProps<{ open: boolean }>();

const emit = defineEmits<{ 'update:open': [open: boolean] }>();
const trackers = useTrackersStore();
const installer = useDriverInstallStore();
const enabledIds = ref<string[]>([]);
const externalId = ref('');
const editorId = ref('');
const revision = ref(0);
const savedValues = ref<Record<string, Record<string, unknown>>>({});
const values = ref<Record<string, string | boolean | number>>({});
const error = ref('');
const loading = ref(true);
const updatesLoading = ref(true);
const updatesError = ref('');
const checking = ref(false);
const testing = ref(false);
const connectionResult = ref<{ ok: boolean; error?: string } | null>(null);
const tokenFailure = ref<{
  driverId: string;
  field: string;
  message: string;
} | null>(null);
const saving = ref<'apply' | 'save' | null>(null);
const saved = ref(false);
const connectionOpen = ref(true);
const installRequest = ref<DriverInstallRequest>({ kind: 'install' });
const removalNeedsRefresh = ref(!!installer.pendingRemoval);
const recoveringRemoval = ref(false);
const drafts = new Map<string, Record<string, string | boolean | number>>();
let settingsReady: Promise<void> | null = null;

const externalDrivers = computed(() =>
  trackers.catalog?.drivers.filter((driver) => driver.id !== 'own' && !driver.deleted) ?? [],
);
const savedDefaultId = computed(() => trackers.catalog?.default ?? trackers.catalog?.externalId);
const savedEnabledIds = computed(() => trackers.catalog?.enabledIds
  ?? (savedDefaultId.value ? [savedDefaultId.value] : []));
const selected = computed(() => externalDrivers.value.find((driver) => driver.id === editorId.value));
const packageInfo = computed(() => installer.installed[editorId.value]);
const driverAvailable = computed(() => ['active', 'available'].includes(selected.value?.status ?? ''));
const activeDriverName = computed(() => externalDrivers.value
  .find((driver) => driver.id === externalId.value)?.name ?? externalId.value);
const busy = computed(() => saving.value !== null || testing.value
  || installer.removing || recoveringRemoval.value);
const packageActionsDisabled = computed(() => loading.value || busy.value || updatesLoading.value
  || checking.value || installer.blocked || removalNeedsRefresh.value);
const operationPending = computed(() => !installer.pendingRemoval && (installer.active
  || installer.unknownOutcome || !!installer.pendingRollback || !!installer.recoveryError));
const tokenInputErrors = computed(() => Object.fromEntries(
  visibleTrackerTokenKeys(selected.value?.schema ?? {}, values.value)
    .filter((key) => !isTrackerTokenInput(String(values.value[key] ?? '')))
    .map((key) => [key, t('core.trackerTokenInvalidFormat')]),
));
const invalidTokenInput = computed(() => Object.keys(tokenInputErrors.value).length > 0);

/**
 * Настройка использует ту же модальную оболочку вместо диалога поверх установщика.
 * Выбор из результата не сохраняется на сервере до явного применения или сохранения.
 */
async function configureDriver(id?: string) {
  await settingsReady;

  if (id !== undefined && externalDrivers.value.some((driver) => driver.id === id)) {
    editorId.value = id;
  }

  connectionOpen.value = true;
}

/**
 * Переключение на установку сохраняет реквизиты только в памяти текущей формы.
 * Установщик сам восстановит активную операцию до открытия нового маршрута.
 */
function openInstaller() {
  openOperation({ kind: 'install' });
}

/**
 * Мастер получает конкретное действие вместо промежуточного списка пакетов.
 * Черновики остаются в настройках, незавершённая серверная операция сохраняет приоритет.
 */
function openOperation(request: DriverInstallRequest) {
  installRequest.value = request;

  if (!installer.blocked) {
    installer.screen = 'idle';
  }

  connectionOpen.value = false;
}

function openPackageAction(kind: 'version' | 'restore' | 'rollback') {
  if (!packageActionsDisabled.value && packageInfo.value) {
    openOperation({ kind, id: editorId.value });
  }
}

/**
 * Обновление выбранного пакета проходит существующий мастер подтверждения.
 * Перед подготовкой мастер восстановит серверный job, сохраняя приоритет активной операции.
 */
function openUpdate() {
  if (packageActionsDisabled.value || !packageInfo.value?.updateAvailable || packageInfo.value.localChanges) {
    return;
  }

  openOperation({ kind: 'update', id: editorId.value });
}

/**
 * Версия и сохранённый результат проверки читаются без обращения к репозиториям.
 * Ошибка этих сведений не мешает редактировать и сохранять подключение доски.
 */
async function loadPackageInfo() {
  updatesLoading.value = true;
  updatesError.value = '';

  try {
    await installer.readInstalled();
  } catch (cause) {
    updatesError.value = failureText(cause);
  } finally {
    updatesLoading.value = false;
  }
}

/**
 * Сетевой поиск версий выполняется только явной кнопкой и не сохраняет реквизиты.
 * Форма и её черновики остаются открытыми при успешной проверке и при отказе.
 */
async function checkUpdates() {
  if (packageActionsDisabled.value) {
    return;
  }

  checking.value = true;
  updatesError.value = '';

  try {
    if (!await installer.check()) {
      updatesError.value = installer.error;
    }
  } finally {
    checking.value = false;
  }
}

/**
 * Кнопка удаляет выбранный редактором пакет через общее подтверждение без сохранения черновиков.
 * Неизвестный исход и отказ перечитывания проверяются в форме без повторного удаления.
 */
async function removeSelected() {
  const driver = selected.value;

  if (!driver || packageActionsDisabled.value) {
    return;
  }

  error.value = '';
  saved.value = false;

  const removed = await installer.confirmRemove(driver.id, driver.name);

  if (installer.unknownOutcome || (removed && installer.refreshError)) {
    removalNeedsRefresh.value = true;
  } else if (removed === false) {
    error.value = installer.error;
  } else if (removed) {
    revision.value = trackers.catalog?.revision ?? revision.value;
    updatesError.value = installer.refreshError;
  }
}

/**
 * Повтор проверяет каталог после удаления, не отправляя мутацию заново.
 * Пока состояние неизвестно, сохранение не может вернуть удалённый драйвер в черновой набор.
 */
async function recoverRemoval() {
  if (busy.value) {
    return;
  }

  recoveringRemoval.value = true;

  try {
    if (installer.pendingRemoval || installer.unknownOutcome) {
      await installer.current();
    } else {
      await installer.refreshAfterMutation();
    }

    removalNeedsRefresh.value = installer.unknownOutcome || !!installer.refreshError || !!installer.error;
    revision.value = trackers.catalog?.revision ?? revision.value;
  } finally {
    recoveringRemoval.value = false;
  }
}

watch([externalId, editorId, values], () => {
  saved.value = false;
  connectionResult.value = null;
  tokenFailure.value = null;
}, { deep: true });

/**
 * Включение и редактор независимы; снятие дефолта выбирает первый оставшийся источник.
 * Сервер повторно нормализует этот выбор при сохранении по ревизии.
 */
function setEnabled(enabled: boolean) {
  enabledIds.value = enabled ? [...new Set([...enabledIds.value, editorId.value])]
    : enabledIds.value.filter((id) => id !== editorId.value);

  if (!enabledIds.value.includes(externalId.value)) {
    externalId.value = enabledIds.value[0] ?? '';
  }
}

/**
 * Выбранный редактором драйвер становится основной доской и включается при необходимости.
 * Назначение меняет только черновик, сохранённые чипы обновятся после записи настроек.
 */
function makeDefault() {
  if (busy.value || loading.value || !driverAvailable.value) {
    return;
  }

  setEnabled(true);
  externalId.value = editorId.value;
}

function fieldError(key: string): string | undefined {
  return tokenInputErrors.value[key] || (tokenFailure.value?.driverId === editorId.value
    && tokenFailure.value.field === key ? tokenFailure.value.message : undefined);
}

/**
 * Дополнение схемы происходит после ввода, чтобы не сдвигать курсор при наборе адреса.
 * Секреты и поля других типов сохраняют исходное значение.
 */
function normalizePortalField(key: string, field: TrackerSettingsField) {
  const value = values.value[key];

  if (typeof value === 'string') {
    values.value[key] = normalizeTrackerPortalInput(field, value);
  }
}

/**
 * Поле токена объясняет назначение секрета до первой отправки формы.
 * Общая подсказка о пустом вводе сохраняется для прежних пакетов и режима пароля.
 */
function fieldHint(field: TrackerSettingsField): string | undefined {
  if (isTrackerTokenField(field)) {
    return `${t('core.trackerTokenHint')} ${t('core.trackerSecretKept')}`;
  }

  return field.secret ? t('core.trackerSecretKept') : undefined;
}

/**
 * При отказе черновика другого драйвера открывается его редактор с ошибкой поля.
 * Значение секрета остаётся в памяти формы, сервер возвращает только безопасную причину.
 */
async function showTokenFailure(cause: unknown) {
  if (!(cause instanceof ApiError) || !isRecord(cause.data)
    || cause.data.error !== 'tracker_token_invalid'
    || typeof cause.data.driverId !== 'string' || typeof cause.data.field !== 'string') {
    return;
  }

  editorId.value = cause.data.driverId;
  await nextTick();
  tokenFailure.value = {
    driverId: cause.data.driverId,
    field: cause.data.field,
    message: failureText(cause),
  };
}

/**
 * Проверка и сохранение отправляют только видимые поля текущего режима схемы.
 * Скрытые реквизиты остаются в черновике формы до возврата в прежний режим.
 */
function visibleValues(id: string, draft: Record<string, string | boolean | number>) {
  const schema = externalDrivers.value.find((driver) => driver.id === id)?.schema ?? {};

  return Object.fromEntries(Object.entries(schema)
    .filter(([, field]) => !field.visibleIf || draft[field.visibleIf.field] === field.visibleIf.equals)
    .map(([key, field]) => {
      const value = draft[key];

      return [key, typeof value === 'string' ? normalizeTrackerPortalInput(field, value) : value];
    }));
}

/**
 * Проверяется выбранный редактором драйвер с текущим вводом, независимо от флажка доски.
 * Сервер сохраняет прежний секрет при пустом поле и не записывает настройки проверки.
 */
async function checkConnection() {
  if (busy.value || loading.value || !driverAvailable.value || invalidTokenInput.value) {
    return;
  }

  testing.value = true;
  connectionResult.value = null;

  try {
    connectionResult.value = await api.post('/api/trackers/test-connection', {
      driverId: editorId.value,
      settings: visibleValues(editorId.value, values.value),
      expectedRevision: revision.value,
    }) as { ok: boolean; error?: string };
  } catch (cause) {
    connectionResult.value = { ok: false, error: failureText(cause) };
    await showTokenFailure(cause);
  } finally {
    testing.value = false;
  }
}

/**
 * Подпись схемы переводится только при явном descriptor ключа.
 * Строка данных и запасное имя поля остаются буквальным текстом.
 */
function fieldLabel(value: TrackerLabel | undefined, fallback: string | number): string {
  if (typeof value === 'string') {
    return value;
  }

  return value ? 'text' in value ? value.text
    : resolveUiText(messageRef(value.key, value.params)) : String(fallback);
}

function fieldVisible(field: TrackerSettingsField): boolean {
  return !field.visibleIf || values.value[field.visibleIf.field] === field.visibleIf.equals;
}

watch(editorId, (id, previous) => {
  if (previous) {
    drafts.set(previous, { ...values.value });
  }

  const initial = Object.entries(selected.value?.schema ?? {}).map(([key, field]) => [
    key,
    field.secret ? '' : savedValues.value[id]?.[key] ?? (field.type === 'boolean' ? false : ''),
  ]);

  values.value = drafts.get(id) ?? Object.fromEntries(initial) as typeof values.value;
});

watch(() => trackers.catalog, (catalog) => {
  const deletedIds = catalog?.drivers.filter((driver) => driver.deleted).map((driver) => driver.id) ?? [];

  if (catalog && deletedIds.some((id) => enabledIds.value.includes(id)
    || id === externalId.value || id === editorId.value)) {
    enabledIds.value = enabledIds.value.filter((id) => !deletedIds.includes(id));

    if (deletedIds.includes(externalId.value)) {
      externalId.value = catalog.default ?? catalog.externalId ?? '';
    }

    revision.value = catalog.revision;
  }

  if (!loading.value && catalog && !externalDrivers.value.some((driver) => driver.id === editorId.value)) {
    editorId.value = catalog.externalId ?? externalDrivers.value[0]?.id ?? '';
  }
});

/**
 * Диалог читает выбор с сервера и никогда не заполняет поле пароля секретом.
 * Ошибка загрузки оставляет форму видимой и не выдаёт локальное значение за сохранённое.
 */
async function load() {
  try {
    await trackers.load(true);

    const settings = await api.get('/api/trackers/settings') as {
      externalId: string | null;
      drivers?: string[];
      default?: string | null;
      revision: number;
      settings: Record<string, Record<string, unknown>>;
    };

    savedValues.value = settings.settings;
    revision.value = settings.revision;
    externalId.value = settings.default ?? settings.externalId ?? '';
    enabledIds.value = settings.drivers ?? (settings.externalId ? [settings.externalId] : []);
    editorId.value = settings.externalId ?? externalDrivers.value[0]?.id ?? '';
  } catch (cause) {
    error.value = failureText(cause);
  } finally {
    loading.value = false;
  }
}

/**
 * Сервер сравнивает ревизию перед сохранением выбора и реквизитов.
 * Применение обновляет базу черновика; сохранение дополнительно закрывает окно только после успеха.
 */
async function save(closeAfterSave: boolean) {
  if (busy.value || loading.value || invalidTokenInput.value || removalNeedsRefresh.value) {
    return;
  }

  saving.value = closeAfterSave ? 'save' : 'apply';
  saved.value = false;
  error.value = '';

  try {
    const pending = new Map(drafts);

    pending.set(editorId.value, { ...values.value });

    const settings = Object.fromEntries([...pending]
      .filter(([id]) => externalDrivers.value.some((driver) => driver.id === id))
      .map(([id, draft]) => {
        const schema = externalDrivers.value.find((driver) => driver.id === id)?.schema ?? {};
        const changed = Object.entries(visibleValues(id, draft)).filter(([key, value]) => {
          if (schema[key]?.secret && value === '') {
            return false;
          }

          return value !== savedValues.value[id]?.[key];
        });

        return [id, Object.fromEntries(changed)];
      }));
    const result = await trackers.saveSettings({
      ...(trackers.catalog?.enabledIds ? {
        drivers: [...enabledIds.value], default: externalId.value || null,
      } : { externalId: externalId.value || null }),
      settings,
      expectedRevision: revision.value,
    }) as { revision: number };

    revision.value = result.revision;

    for (const [id, changed] of Object.entries(settings)) {
      savedValues.value[id] = { ...savedValues.value[id], ...changed };
    }

    saved.value = true;

    if (closeAfterSave) {
      emit('update:open', false);
    }
  } catch (cause) {
    error.value = failureText(cause);
    await showTokenFailure(cause);
  } finally {
    saving.value = null;
  }
}

onMounted(() => {
  settingsReady = load();
  void loadPackageInfo();
});
</script>

<style scoped>
.tracker-settings {
  min-width: 0;
  overflow-wrap: anywhere;
  container: tracker-settings / inline-size;
}

.tracker-settings__workspace {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 16px;
  min-width: 0;
  align-items: start;
}

.tracker-settings__heading,
.tracker-settings__driver-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.tracker-settings__title {
  flex: 1;
  min-width: 0;
}

.tracker-settings__sidebar,
.tracker-settings__catalog,
.tracker-settings__catalog-actions,
.tracker-settings__editor,
.tracker-settings__section,
.tracker-settings__fields {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.tracker-settings__sidebar {
  padding-right: 16px;
  border-right: 1px solid var(--line);
}

.tracker-settings__catalog,
.tracker-settings__catalog-actions {
  gap: 8px;
}

.tracker-settings__picker {
  display: none;
}

.tracker-settings__loading-driver,
.tracker-settings__loading-field {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.tracker-settings__loading-driver {
  gap: 4px;
  padding: 11px;
}

.tracker-settings__catalog h3 {
  margin: 0 0 4px;
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 500;
}

.tracker-settings__driver-heading {
  flex-wrap: wrap;
}

.tracker-settings__driver-heading h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
}

.tracker-settings__section {
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.tracker-settings__section h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.tracker-settings__note,
.tracker-settings__version {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.tracker-settings__actions {
  width: 100%;
}

.tracker-settings__connection-hint {
  flex: 1 1 240px;
}

@container tracker-settings (max-width: 680px) {
  .tracker-settings__workspace {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
  }

  .tracker-settings__sidebar {
    padding: 0 0 16px;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .tracker-settings__catalog {
    display: none;
  }

  .tracker-settings__picker {
    display: block;
  }

  .tracker-settings__catalog-actions {
    display: flex;
    flex-wrap: wrap;
  }
}
</style>
