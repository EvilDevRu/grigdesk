import { computed, h, markRaw, ref, watch } from 'vue';
import { defineStore } from 'pinia';

import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import {
  decodeProviderInstallPreparation,
  decodeProviderInstallSnapshot,
  type ProviderInstallJob as ProviderInstallJobV1,
  type ProviderInstallNotice,
  type ProviderInstallOperation,
  type ProviderInstallPreparation,
  type ProviderInstallSnapshot as ProviderInstallSnapshotV1,
  type ProviderInstallTerminal,
} from '../../../shared/chat/providerInstallContracts.ts';
import {
  isProviderLifecycleSnapshot, isProviderLifecyclePreparation,
  type ProviderLifecycleJob, type ProviderLifecycleSnapshot, type ProviderLifecycleOperation,
} from '../../../shared/chat/providerLifecycleContracts.ts';

import { isRecord } from '../../../shared/lib/objects.ts';
import { api, ApiError, failureText } from '../shared/apiClient.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';
import { confirmDialog } from '../ui.ts';
import ProviderIcon from '../shared/ProviderIcon.vue';
import { useAuthStore } from './auth.ts';
import { connectProviderCliUpdate, useProvidersStore } from './providers.ts';

type ProviderInstallJob = ProviderInstallJobV1 | ProviderLifecycleJob;
type ProviderInstallSnapshot = ProviderInstallSnapshotV1 | ProviderLifecycleSnapshot;

const t = localeTranslator(uiLocalePort);

const noticeKeys: Readonly<Record<string, string>> = {
  busy: 'settings.providerInstallationBusy',
  unknown_provider: 'settings.providerInstallationUnknownProvider',
  no_update: 'settings.providerInstallationManaged',
  unsupported_action: 'settings.providerInstallationUnsupported',
  already_installed: 'settings.providerInstallationAlreadyInstalled',
  not_installed: 'settings.providerInstallationNotInstalled',
  timeout: 'settings.providerInstallationTimeout',
  interrupted: 'settings.providerInstallationInterrupted',
  command_exit_failed: 'settings.providerInstallationCommandFailed',
  uninstall_unverified: 'settings.providerInstallationUninstallUnverified',
  version_unverified: 'settings.providerInstallationVersionUnverified',
  version_stale: 'settings.providerInstallationVersionStale',
  npm_missing: 'settings.providerInstallationNpmMissing',
  npm_binary_missing: 'settings.providerInstallationNpmBinaryMissing',
  npm_binding_failed: 'settings.providerInstallationNpmBindingFailed',
  worker_unconfirmed: 'settings.providerInstallationWorkerUnconfirmed',
  state_unavailable: 'settings.providerInstallationStateUnavailable',
  state_write_failed: 'settings.providerInstallationStateWriteFailed',
  models_refresh_failed: 'settings.providerInstallationModelsFailed',
  updates_check_failed: 'settings.providerInstallationUpdatesFailed',
  npm_runtime_missing: 'settings.providerInstallationNpmRuntimeMissing',
  npm_prefix_invalid: 'settings.providerInstallationPrefixInvalid',
  npm_prefix_unwritable: 'settings.providerInstallationPrefixUnwritable',
  npm_prefix_nvm_scoped: 'settings.providerInstallationPrefixNvmScoped',
  npm_bin_conflict: 'settings.providerInstallationBinConflict',
  shell_probe_failed: 'settings.providerInstallationShellProbeFailed',
  terminal_setup_required: 'settings.providerInstallationTerminalSetupRequired',
  terminal_command_conflict: 'settings.providerInstallationTerminalCommandConflict',
  migration_recovery_required: 'settings.providerInstallationMigrationRecoveryRequired',
  lifecycle_recovery_required: 'settings.providerInstallationRecoveryRequired',
  cli_selection_conflict: 'settings.providerInstallationSelectionConflict',
  terminal_conflict: 'settings.providerInstallationTerminalConflict',
  npm_graph_changed: 'settings.providerInstallationGraphChanged',
  npm_graph_invalid: 'settings.providerInstallationGraphInvalid',
  installer_strategy_unverified: 'settings.providerInstallationStrategyUnverified',
  installation_conflict: 'settings.providerInstallationConflict',
  installer_side_effect_conflict: 'settings.providerInstallationSideEffectConflict',
  exact_reinstall_unsupported: 'settings.providerInstallationExactUnsupported',
  cli_missing: 'settings.providerInstallationCliMissing',
  migration_block_dependency: 'settings.providerInstallationMigrationBlockDependency',
  migration_source_not_owned: 'settings.providerInstallationMigrationSourceNotOwned',
  migration_version_conflict: 'settings.providerInstallationMigrationVersionConflict',
  migration_entries_invalid: 'settings.providerInstallationMigrationEntriesInvalid',
  migration_cleanup_pending: 'settings.providerInstallationMigrationCleanupPending',
  shell_cleanup_conflict: 'settings.providerInstallationShellCleanupConflict',
  shell_cleanup_skipped: 'settings.providerInstallationShellCleanupSkipped',
  shell_cleanup_absent: 'settings.providerInstallationShellCleanupAbsent',
  legacy_binding_replaced: 'settings.providerInstallationLegacyBindingReplaced',
  preparation_changed: 'settings.providerInstallationPreparationChanged',
  preparation_expired: 'settings.providerInstallationPreparationExpired',
  preparation_invalid: 'settings.providerInstallationPreparationInvalid',
  preparation_consumed: 'settings.providerInstallationPreparationConsumed',
  server_restart_required: 'settings.providerInstallationServerRestart',
};

type StartFailure = {
  providerId: string;
  previousJobId: string;
  operation: ProviderLifecycleOperation;
  phase: 'prepare' | 'start';
  message: string | ProviderInstallNotice;
  fallbackCommand: string;
};

type LifecycleRequest = {
  providerId: string;
  operation: ProviderLifecycleOperation;
  phase: 'preparing' | 'confirming' | 'starting';
};

const emptySnapshot = (): ProviderInstallSnapshot => ({
  revision: 0,
  active: null,
  recent: {},
  blockedReason: null,
});

/**
 * Сообщение сервера сохраняет конкретную причину даже при известном общем коде.
 * Перевод по коду служит запасным текстом; строки и вывод CLI остаются данными.
 */
export function providerInstallNoticeText(notice: string | ProviderInstallNotice | null): string {
  if (!notice || typeof notice === 'string') {
    return notice || '';
  }
  if (notice.message.trim()) {
    return notice.message;
  }

  const key = Object.hasOwn(noticeKeys, notice.code) ? noticeKeys[notice.code] : undefined;

  return key ? t(key) : notice.message;
}

// Справочные коды остаются в job для диагностики, но человеку их не показываем:
// управляемый блок PATH держит абсолютный каталог, и смена версии nvm копию не теряет.
const quietNoticeCodes: ReadonlySet<string> = new Set(['npm_prefix_nvm_scoped']);

/**
 * Предупреждения, которые видит человек и которые делают итог «требующим внимания».
 * Справочные коды отбрасываются одинаково для окна, всплывашки и строки итога.
 */
export function providerInstallVisibleWarnings(job: ProviderInstallJob): ProviderInstallJob['warnings'] {
  return job.warnings.filter((warning) => typeof warning === 'string' || !quietNoticeCodes.has(warning.code));
}

/**
 * Отказ API сохраняет исходный message, а код даёт запасной текст при его отсутствии.
 * Транспортные ошибки не объявляются собственными причинами сервера.
 */
function failureNotice(failure: unknown): string | ProviderInstallNotice {
  if (failure instanceof ApiError && isRecord(failure.data) && typeof failure.data.error === 'string') {
    return {
      code: failure.data.error,
      message: typeof failure.data.message === 'string' ? failure.data.message
        : Object.hasOwn(noticeKeys, failure.data.error) ? '' : failureText(failure),
    };
  }

  return failureText(failure);
}

/**
 * CLI печатает версию с подписью продукта, например «2.1.310 (Claude Code)»: в итоге остаётся номер.
 * Строка без распознанного номера показывается как получена.
 */
function versionLabel(value: string): string {
  return value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/u)?.[0] || value;
}

/**
 * Итог терминала не смешивается с успехом CLI: установленная копия может
 * работать в GrigDesk и не находиться по имени в обычной оболочке.
 */
export function providerInstallTerminalText(terminal: ProviderInstallTerminal | undefined): string {
  if (!terminal) {
    return '';
  }
  if (terminal.status === 'ready') {
    return t('settings.providerInstallationTerminalReady');
  }
  if (terminal.status === 'conflict') {
    return t('settings.providerInstallationTerminalConflict');
  }

  return t('settings.providerInstallationTerminalSetup', { directory: terminal.binDirectory });
}

/**
 * Перенос копии при равной версии объясняется отдельно от смены версии.
 * Старые снимки без этих полей остаются читаемыми и не обещают готовность.
 */
function providerInstallExtraLines(job: ProviderInstallJob): string[] {
  const lines: string[] = [];

  if (job.migration) {
    lines.push(t('settings.providerInstallationMigrated', {
      from: job.migration.from,
      to: job.migration.to,
    }));
  }

  const terminal = providerInstallTerminalText(job.terminal);

  if (terminal) {
    lines.push(terminal);
  }

  return lines;
}

/**
 * Результат CLI отделён от результата каталога моделей и переводится при чтении.
 * Причины сервера и сырой вывод остаются данными, подписи итога переводятся при показе.
 */
export function providerInstallResultText(job: ProviderInstallJob): string {
  let text: string;

  if (job.status === 'interrupted') {
    text = t('settings.providerInstallationInterrupted');
  } else if (job.status === 'failed' || job.status === 'needs_attention') {
    text = t('settings.providerInstallationFailed', {
      reason: providerInstallNoticeText(job.error) || job.outputTail,
    });
  } else if (job.outcome === 'uninstalled') {
    text = t('settings.providerLifecycleUninstalled');
  } else if (job.outcome === 'reinstalled') {
    text = t('settings.providerLifecycleReinstalled', { version: versionLabel(job.after) });
  } else if (job.outcome === 'migrated' || job.outcome === 'activated_with_cleanup_pending') {
    text = t('settings.providerLifecycleMigrated');
  } else if (job.outcome === 'installed') {
    text = t('settings.providerInstallationInstalled', { version: versionLabel(job.after) });
  } else if (job.outcome === 'updated') {
    text = t('settings.providerInstallationUpdated', {
      before: versionLabel(job.before),
      after: versionLabel(job.after),
    });
  } else {
    text = t('settings.providerInstallationCurrent', { version: versionLabel(job.after || job.before) });
  }

  return [
    text,
    ...providerInstallExtraLines(job),
    ...providerInstallVisibleWarnings(job).map(providerInstallNoticeText),
  ].join('\n');
}

export const useProviderInstallStore = defineStore('provider-install', () => {
  const auth = useAuthStore();
  const providers = useProvidersStore();
  const snapshot = ref<ProviderInstallSnapshot>(emptySnapshot());
  const visible = ref(false);
  const providerId = ref('');
  const pending = ref('');
  const request = ref<LifecycleRequest | null>(null);
  const uncertain = ref(false);
  const errorNotice = ref<string | ProviderInstallNotice>('');
  const error = computed({
    get: () => providerInstallNoticeText(errorNotice.value),
    set: (value: string) => {
      errorNotice.value = value;
    },
  });
  const startFailure = ref<StartFailure | null>(null);
  let generation = 0;
  let selectedV2 = false;
  let receivedSnapshot = false;
  const supportsV2 = computed(() => providers.providers.some((entry) =>
    entry.installation?.lifecycleProtocol === 2));

  const busy = computed(() => !!snapshot.value.active || !!snapshot.value.blockedReason
    || !!pending.value || uncertain.value);
  const selectedFailure = computed(() => startFailure.value?.providerId === providerId.value
    ? { ...startFailure.value, message: providerInstallNoticeText(startFailure.value.message) } : null);
  const selectedRequest = computed(() => request.value?.providerId === providerId.value
    ? request.value : null);
  const selectedJob = computed(() => selectedFailure.value ? null
    : snapshot.value.active?.providerId === providerId.value
      ? snapshot.value.active
      : selectedRequest.value ? null : snapshot.value.recent[providerId.value] || null);

  /**
   * Старые потребители providers получают проекцию одного серверного lock и итогов.
   * Успех не появляется при 202; новый финал перечитывает каталог один раз.
   */
  function project(previous: ProviderInstallSnapshot, refreshNewFinals = false): void {
    providers.updating = snapshot.value.active?.providerId || pending.value || '';

    const results = { ...providers.updateResults };
    let refreshRegistry = false;

    if (snapshot.value.active) {
      results[snapshot.value.active.providerId] = null;
    }

    for (const [id, job] of Object.entries(snapshot.value.recent)) {
      if (snapshot.value.active?.providerId === id) {
        continue;
      }

      results[id] = {
        type: job.status === 'succeeded' ? 'ok' : 'err',
        get text() {
          return providerInstallResultText(job);
        },
        changed: job.status === 'succeeded' && job.outcome === 'updated',
      };

      if (previous.active?.providerId === id && previous.active.id === job.id
        || refreshNewFinals && previous.recent[id]?.id !== job.id) {
        refreshRegistry = true;
      }
    }

    if (pending.value) {
      results[pending.value] = null;
    }

    const failure = startFailure.value;

    if (failure) {
      results[failure.providerId] = {
        type: 'err',
        get text() {
          return providerInstallNoticeText(failure.message);
        },
        changed: false,
      };
    }

    providers.updateResults = results;

    if (refreshRegistry) {
      void providers.load(true);
    }
  }

  /**
   * Revision относится к целому снимку, поэтому поздний GET не откатывает SSE.
   * Неверный ответ оставляет прежнюю проекцию и понятную транспортную ошибку.
   */
  function applySnapshot(value: unknown): boolean {
    try {
      const v2 = isRecord(value) && value.schemaVersion === 2;

      if (selectedV2 && !v2 || v2 && !supportsV2.value) {
        return false;
      }
      if (v2 && !isProviderLifecycleSnapshot(value)) {
        throw new Error(t('settings.providerNoResponse'));
      }

      const next = v2 ? value as unknown as ProviderLifecycleSnapshot : decodeProviderInstallSnapshot(value);

      selectedV2 ||= v2;

      if (next.revision < snapshot.value.revision) {
        return false;
      }

      const previous = snapshot.value;

      snapshot.value = structuredClone(next);
      uncertain.value = false;
      error.value = '';

      const failure = startFailure.value;
      const resolvedJob = failure && (next.active?.providerId === failure.providerId
        ? next.active : next.recent[failure.providerId]);

      // После prepare команды ещё не было: впервые загруженная старая история
      // не может подтвердить её старт. Для потерянного start остаётся сверка итога.
      if (failure && resolvedJob && resolvedJob.id !== failure.previousJobId
        && resolvedJob.operation === failure.operation
        && (failure.phase === 'start' || resolvedJob.status === 'running')) {
        startFailure.value = null;
      }

      project(previous, v2 && receivedSnapshot || !!pending.value);
      receivedSnapshot = true;

      return true;
    } catch (failure) {
      errorNotice.value = failureNotice(failure);

      return false;
    }
  }

  /**
   * Ответ прежней машины отбрасывается независимо от его численной revision.
   * Неизвестный исход POST сверяется чтением без автоматического повтора команды.
   */
  async function load(): Promise<void> {
    const scope = generation;

    try {
      const response = await api.get(supportsV2.value
        ? '/api/providers/installations/v2/current' : '/api/providers/installations/current');

      if (scope === generation) {
        applySnapshot(response);
      }
    } catch (failure) {
      if (scope === generation) {
        errorNotice.value = failureNotice(failure);
      }
    }
  }

  function show(id: string): void {
    providerId.value = id;
    visible.value = true;
  }

  /**
   * Окно и блокировка повторного клика появляются до первого сетевого ожидания.
   * История остаётся в snapshot, но новая подготовка скрывает её итог и прежний отказ.
   */
  function beginRequest(id: string, operation: ProviderLifecycleOperation): () => void {
    const wasVisible = visible.value && providerId.value === id;
    const previousFailure = startFailure.value;
    const previousError = errorNotice.value;

    pending.value = id;
    request.value = {
      providerId: id,
      operation,
      phase: 'preparing',
    };
    startFailure.value = null;
    error.value = '';
    show(id);
    project(snapshot.value);

    return () => {
      visible.value = wasVisible;
      startFailure.value = previousFailure;
      errorNotice.value = previousError;
    };
  }

  /**
   * Старый сервер отдаёт только финальный результат прежнего маршрута обновления.
   * Сохраняем его рабочее действие без выдуманного job и без повторного POST при сбое.
   */
  async function updateLegacy(id: string, scope: number): Promise<void> {
    providers.updating = id;
    providers.updateResults = { ...providers.updateResults, [id]: null };

    try {
      const response = await api.post(`/api/providers/${encodeURIComponent(id)}/update`, {});

      if (scope !== generation) {
        return;
      }
      if (!isRecord(response) || typeof response.ok !== 'boolean') {
        throw new Error(t('settings.providerNoResponse'));
      }

      const before = typeof response.before === 'string' ? response.before : '';
      const after = typeof response.after === 'string' ? response.after : '';
      const reason = typeof response.output === 'string' ? response.output.slice(-300) : '';
      const changed = response.ok && response.changed === true;
      const key = !response.ok ? 'settings.providerCliFailure'
        : changed ? 'settings.providerInstallationUpdated' : 'settings.providerCliCurrent';

      providers.updateResults = {
        ...providers.updateResults,
        [id]: {
          type: response.ok ? 'ok' : 'err',
          get text() {
            return t(key, {
              before: before || '?',
              after,
              version: after || before,
              reason,
            });
          },
          changed,
        },
      };
      await providers.load(true);
    } catch (failure) {
      if (scope === generation) {
        providers.updateResults = {
          ...providers.updateResults,
          [id]: {
            type: 'err',
            text: failureText(failure),
            changed: false,
          },
        };
      }
    }
  }

  /**
   * Подготовка — серверный preview выбранного каталога и будущих правок оболочки.
   * Ответ другой машины отбрасывается по generation и не открывает подтверждение.
   */
  async function prepareInstall(id: string, operation: ProviderInstallOperation, scope: number):
    Promise<ProviderInstallPreparation | null> {
    try {
      const response = await api.post(
        `/api/providers/${encodeURIComponent(id)}/${operation}/prepare`, {});

      if (scope !== generation) {
        return null;
      }

      return decodeProviderInstallPreparation(response);
    } catch (failure) {
      if (scope === generation) {
        // 404 на этом маршруте означает старый сервер без подготовки: окно уже
        // новее сервера, и честный следующий шаг — перезапуск, а не повтор.
        const notice = failure instanceof ApiError && failure.status === 404
          ? { code: 'server_restart_required', message: '' }
          : failureNotice(failure);

        errorNotice.value = notice;
        startFailure.value = {
          providerId: id,
          previousJobId: snapshot.value.recent[id]?.id || '',
          operation,
          phase: 'prepare',
          message: notice,
          fallbackCommand: '',
        };

        // Отказ подготовки виден у самой карточки: молчащий клик неотличим
        // от неработающей кнопки, например при сервере без нового маршрута.
        providers.updateResults = {
          ...providers.updateResults,
          [id]: {
            type: 'err',
            text: providerInstallNoticeText(notice),
            changed: false,
          },
        };
        show(id);
      }

      return null;
    }
  }

  /**
   * V2 подтверждает конкретные файлы и одну установленную версию до destructive start.
   * Потерянный ACK сверяется через current; повтор POST автоматически не выполняется.
   */
  async function requestLifecycle(id: string, operation: ProviderLifecycleOperation): Promise<void> {
    const provider = providers.providers.find((entry) => entry.id === id);
    const scope = generation;
    const route = `/api/providers/installations/v2/${encodeURIComponent(id)}/${operation}`;

    if (!provider || busy.value || operation === 'migrate') {
      return;
    }

    const restoreView = beginRequest(id, operation);

    let phase: 'prepare' | 'start' = 'prepare';

    try {
      const response = await api.post(`${route}/prepare`, {});

      if (scope !== generation) {
        return;
      }
      if (!isProviderLifecyclePreparation(response)) {
        throw new Error(t('settings.providerNoResponse'));
      }

      // Живые сессии закрываются только явным подтверждением: владелец видит,
      // какие разговоры прервутся, до запуска операции вместо загадочного 409.
      const holders = response.holders ?? [];

      if (holders.length) {
        const minutesOf = (seconds: number) => Math.max(1, Math.round(seconds / 60));
        const holderLines = holders.map((holder) => holder.chatKey
          ? t('settings.providerSessionHoldersChatLine',
            { chat: holder.chatKey, minutes: minutesOf(holder.ageSeconds) })
          : t('settings.providerSessionHoldersProcessLine',
            { pid: String(holder.ownerPid), minutes: minutesOf(holder.ageSeconds) }));
        const closeConfirmed = await confirmDialog(
          `${t('settings.providerSessionHoldersBody')}\n${holderLines.join('\n')}`, {
            title: t('settings.providerSessionHoldersTitle', { name: provider.name }),
            okText: t('settings.providerSessionHoldersAction'),
            danger: true,
          });

        if (!closeConfirmed || scope !== generation) {
          if (scope === generation) {
            restoreView();
          }

          return;
        }

        const closed = await api.post(
          `/api/providers/installations/v2/${encodeURIComponent(id)}/sessions/close`, {});
        const remaining = isRecord(closed) && Array.isArray(closed.holders) ? closed.holders : [];

        if (remaining.length) {
          throw new Error(t('settings.providerSessionHoldersCloseFailed'));
        }
      }

      const actionKeys = {
        install: 'settings.providerInstallationInstall',
        update: 'settings.providerInstallationUpdate',
        reinstall: 'settings.providerLifecycleReinstall',
        uninstall: 'settings.providerLifecycleUninstall',
      } as const;
      const action = t(actionKeys[operation]);
      const version = operation === 'uninstall' ? response.fromVersion
        : response.targetVersion ?? response.fromVersion;
      const program = [provider.name, version].filter(Boolean).join(' ');
      const body = [
        `${t(`settings.providerLifecycleSummary_${operation}`, { program })} `
          + t('settings.providerLifecyclePreserveData'),
        ...response.warnings.map(providerInstallNoticeText),
      ].join('\n');
      const details = [
        response.command,
        response.prefix ? t('settings.providerInstallationPrefixLine', { prefix: response.prefix }) : '',
        ...response.footprint.map((item) =>
          `${t(`settings.providerLifecycleEffect_${item.action}`)}: ${item.path}`),
        ...response.shellChanges.map((item) => `${item.file}: ${item.block}`),
      ].filter(Boolean).join('\n');

      request.value!.phase = 'confirming';

      const confirmed = await confirmDialog(body, {
        title: t('settings.providerInstallationConfirmTitle', { action, name: provider.name }),
        details: { label: t('settings.providerLifecycleDetails'), text: details },
        okText: action,
        danger: operation === 'uninstall',
        icon: operation === 'uninstall' ? 'trash' : undefined,
      });

      if (!confirmed || scope !== generation) {
        if (scope === generation) {
          restoreView();
        }

        return;
      }

      phase = 'start';
      request.value!.phase = 'starting';
      startFailure.value = null;
      show(id);

      const started = await api.post(`${route}/start`, { preparationToken: response.token });

      if (scope === generation && !applySnapshot(started)) {
        uncertain.value = true;
        await load();
      }
    } catch (failure) {
      if (scope !== generation) {
        return;
      }

      errorNotice.value = failureNotice(failure);
      startFailure.value = {
        providerId: id,
        previousJobId: snapshot.value.recent[id]?.id || '',
        operation,
        phase,
        message: failureNotice(failure),
        fallbackCommand: '',
      };
      show(id);

      if (phase === 'start') {
        uncertain.value = true;

        if (failure instanceof ApiError && isRecord(failure.data) && failure.data.snapshot) {
          applySnapshot(failure.data.snapshot);
        }

        await load();
      }
    } finally {
      if (scope === generation) {
        pending.value = '';
        request.value = null;
        project(snapshot.value);
      }
    }
  }

  /**
   * Подтверждение показывает конкретный результат подготовки: выбранный каталог,
   * команду и имена файлов оболочки, куда допишется PATH. Текст блока человеку не нужен.
   * Старт получает только token. Повторный клик открывает текущий ход и не создаёт
   * второй confirm или POST.
   */
  async function requestInstall(id: string, operation: ProviderLifecycleOperation): Promise<void> {
    if (snapshot.value.active?.providerId === id) {
      show(id);

      return;
    }
    if (busy.value) {
      return;
    }

    const provider = providers.providers.find((entry) => entry.id === id);
    const metadata = provider?.installation;

    if (metadata?.lifecycleProtocol === 2) {
      await requestLifecycle(id, operation);

      return;
    }
    if (operation !== 'install' && operation !== 'update') {
      return;
    }

    const command = operation === 'install' ? metadata?.installCommand : metadata?.updateCommand;
    const legacy = operation === 'update' && !metadata && provider?.installed && provider.canUpdate;

    if (!provider || (!command && !legacy)) {
      return;
    }

    const scope = generation;
    const restoreView = legacy ? null : beginRequest(id, operation);

    if (legacy) {
      pending.value = id;
    }

    try {
      const action = t(operation === 'install'
        ? 'settings.providerInstallationInstall' : 'settings.providerInstallationUpdate');
      const mark = { id: provider.id, name: provider.name };
      const preparation = legacy ? null : await prepareInstall(id, operation, scope);

      if (!legacy && (!preparation || scope !== generation)) {
        return;
      }

      const shellFiles = preparation?.shellChanges
        .map((change) => change.file.split('/').pop() || change.file).join(', ') || '';
      const details = [
        preparation?.command || '',
        preparation?.prefix ? t('settings.providerInstallationPrefixLine',
          { prefix: preparation.prefix }) : '',
        shellFiles ? t('settings.providerInstallationShellFiles', { files: shellFiles }) : '',
        preparation?.terminalSetup === 'manual'
          ? t('settings.providerInstallationShellSetupRequired') : '',
      ].filter(Boolean).join('\n');

      if (request.value) {
        request.value.phase = 'confirming';
      }

      const confirmed = await confirmDialog(legacy
        ? t('settings.providerInstallationLegacyConfirm', { name: provider.name })
        : `${t(`settings.providerLifecycleSummary_${operation}`, { program: provider.name })} `
          + t('settings.providerLifecyclePreserveData'), {
        title: t('settings.providerInstallationConfirmTitle', { action, name: provider.name }),
        icon: markRaw(() => h(ProviderIcon, { provider: mark, size: 20 })),
        iconColor: provider.color,
        details: legacy ? undefined : { label: t('settings.providerLifecycleDetails'), text: details },
        okText: action,
      });

      if (!confirmed || scope !== generation || (!legacy && !preparation)) {
        if (!legacy && scope === generation) {
          restoreView?.();
        }

        return;
      }

      if (legacy) {
        await updateLegacy(id, scope);

        return;
      }

      const previousJobId = snapshot.value.recent[id]?.id || '';

      request.value!.phase = 'starting';
      startFailure.value = null;
      show(id);
      providers.updating = id;

      try {
        const response = await api.post(
          `/api/providers/${encodeURIComponent(id)}/${operation}/start`,
          { preparationToken: preparation!.token });

        if (scope === generation && !applySnapshot(response) && error.value) {
          uncertain.value = true;
          await load();
        }
      } catch (failure) {
        if (scope !== generation) {
          return;
        }

        uncertain.value = true;
        errorNotice.value = failureNotice(failure);
        startFailure.value = {
          providerId: id,
          previousJobId,
          operation,
          phase: 'start',
          message: failureNotice(failure),
          fallbackCommand: (operation === 'install'
            ? metadata?.fallbackInstallCommand : metadata?.fallbackUpdateCommand) || '',
        };

        if (failure instanceof ApiError && isRecord(failure.data) && failure.data.snapshot) {
          applySnapshot(failure.data.snapshot);
        }

        await load();
      }
    } finally {
      if (scope === generation) {
        pending.value = '';
        request.value = null;
        project(snapshot.value);
      }
    }
  }

  watch(() => [auth.clientScope, auth.authenticated], () => {
    generation += 1;
    selectedV2 = false;
    receivedSnapshot = false;
    snapshot.value = emptySnapshot();
    pending.value = '';
    request.value = null;
    uncertain.value = false;
    visible.value = false;
    providerId.value = '';
    error.value = '';
    startFailure.value = null;
    providers.updating = '';
    providers.updateResults = {};
  }, { flush: 'sync' });

  watch(supportsV2, (supported) => {
    if (supported && auth.authenticated) {
      void load();
    }
  });

  return {
    snapshot,
    visible,
    providerId,
    selectedJob,
    selectedFailure,
    selectedRequest,
    pending,
    uncertain,
    error,
    busy,
    load,
    applySnapshot,
    show,
    requestInstall,
  };
});

connectProviderCliUpdate((id) => useProviderInstallStore().requestInstall(id, 'update'));
