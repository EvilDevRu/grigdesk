import { computed, h, markRaw, ref, watch } from 'vue';
import { defineStore } from 'pinia';

import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import {
  decodeProviderInstallPreparation,
  decodeProviderInstallSnapshot,
  type ProviderInstallJob,
  type ProviderInstallNotice,
  type ProviderInstallOperation,
  type ProviderInstallPreparation,
  type ProviderInstallSnapshot,
  type ProviderInstallTerminal,
} from '../../../shared/chat/providerInstallContracts.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { api, ApiError, failureText } from '../shared/apiClient.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';
import { confirmDialog } from '../ui.ts';
import ProviderIcon from '../shared/ProviderIcon.vue';
import { useAuthStore } from './auth.ts';
import { connectProviderCliUpdate, useProvidersStore } from './providers.ts';

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
  preparation_changed: 'settings.providerInstallationPreparationChanged',
  preparation_expired: 'settings.providerInstallationPreparationExpired',
  preparation_invalid: 'settings.providerInstallationPreparationInvalid',
  preparation_consumed: 'settings.providerInstallationPreparationConsumed',
  server_restart_required: 'settings.providerInstallationServerRestart',
};

type StartFailure = {
  providerId: string;
  previousJobId: string;
  operation: ProviderInstallOperation;
  phase: 'prepare' | 'start';
  message: string | ProviderInstallNotice;
  fallbackCommand: string;
};

const emptySnapshot = (): ProviderInstallSnapshot => ({
  revision: 0,
  active: null,
  recent: {},
  blockedReason: null,
});

/**
 * Переводятся только объявленные коды собственных сообщений установки.
 * Старые строки, неизвестные причины и вывод CLI остаются данными без поиска ключей.
 */
export function providerInstallNoticeText(notice: string | ProviderInstallNotice | null): string {
  if (!notice || typeof notice === 'string') {
    return notice || '';
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
 * Отказ API сохраняет код до момента показа и следующей смены языка.
 * Транспортные ошибки не объявляются собственными причинами сервера.
 */
function failureNotice(failure: unknown): string | ProviderInstallNotice {
  if (failure instanceof ApiError && isRecord(failure.data) && typeof failure.data.error === 'string') {
    return { code: failure.data.error, message: failureText(failure) };
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
 * Коды собственных причин переводятся, а сырой вывод остаётся данными.
 */
export function providerInstallResultText(job: ProviderInstallJob): string {
  let text: string;

  if (job.status === 'interrupted') {
    text = t('settings.providerInstallationInterrupted');
  } else if (job.status === 'failed') {
    text = t('settings.providerInstallationFailed', {
      reason: providerInstallNoticeText(job.error) || job.outputTail,
    });
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

  const busy = computed(() => !!snapshot.value.active || !!snapshot.value.blockedReason
    || !!pending.value || uncertain.value);
  const selectedFailure = computed(() => startFailure.value?.providerId === providerId.value
    ? { ...startFailure.value, message: providerInstallNoticeText(startFailure.value.message) } : null);
  const selectedJob = computed(() => selectedFailure.value ? null
    : snapshot.value.active?.providerId === providerId.value
      ? snapshot.value.active : snapshot.value.recent[providerId.value] || null);

  /**
   * Старые потребители providers получают проекцию одного серверного lock и итогов.
   * Успех не появляется при 202; новый финал перечитывает каталог один раз.
   */
  function project(previous: ProviderInstallSnapshot): void {
    providers.updating = snapshot.value.active?.providerId || pending.value || '';

    const results = { ...providers.updateResults };

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

      if (previous.active?.providerId === id && previous.active.id === job.id) {
        void providers.load(true);
      }
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
  }

  /**
   * Revision относится к целому снимку, поэтому поздний GET не откатывает SSE.
   * Неверный ответ оставляет прежнюю проекцию и понятную транспортную ошибку.
   */
  function applySnapshot(value: unknown): boolean {
    try {
      const next = decodeProviderInstallSnapshot(value);

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

      project(previous);

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
      const response = await api.get('/api/providers/installations/current');

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
          ? { code: 'server_restart_required', message: 'Сервер ещё не обновлён' }
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
   * Подтверждение показывает конкретный результат подготовки: выбранный каталог,
   * команду и имена файлов оболочки, куда допишется PATH. Текст блока человеку не нужен.
   * Старт получает только token. Повторный клик открывает текущий ход и не создаёт
   * второй confirm или POST.
   */
  async function requestInstall(id: string, operation: ProviderInstallOperation): Promise<void> {
    if (snapshot.value.active?.providerId === id) {
      show(id);

      return;
    }
    if (busy.value) {
      return;
    }

    const provider = providers.providers.find((entry) => entry.id === id);
    const metadata = provider?.installation;
    const command = operation === 'install' ? metadata?.installCommand : metadata?.updateCommand;
    const legacy = operation === 'update' && !metadata && provider?.installed && provider.canUpdate;

    if (!provider || (!command && !legacy)) {
      return;
    }

    const scope = generation;

    pending.value = id;

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
      const body = [
        preparation?.prefix ? t('settings.providerInstallationPrefixLine',
          { prefix: preparation.prefix }) : '',
        shellFiles ? t('settings.providerInstallationShellFiles', { files: shellFiles }) : '',
        preparation?.terminalSetup === 'manual'
          ? t('settings.providerInstallationManualSetup') : '',
      ].filter(Boolean).join('\n');
      const confirmed = await confirmDialog(legacy
        ? t('settings.providerInstallationLegacyConfirm', { name: provider.name }) : body, {
        title: t('settings.providerInstallationConfirmTitle', { action, name: provider.name }),
        subtitle: legacy ? undefined : t('settings.providerInstallationConfirmSubtitle'),
        icon: markRaw(() => h(ProviderIcon, { provider: mark, size: 20 })),
        iconColor: provider.color,
        code: legacy ? undefined : preparation?.command || undefined,
        okText: action,
      });

      if (!confirmed || scope !== generation || (!legacy && !preparation)) {
        return;
      }

      if (legacy) {
        await updateLegacy(id, scope);

        return;
      }

      const previousJobId = snapshot.value.recent[id]?.id || '';

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
        project(snapshot.value);
      }
    }
  }

  watch(() => [auth.clientScope, auth.authenticated], () => {
    generation += 1;
    snapshot.value = emptySnapshot();
    pending.value = '';
    uncertain.value = false;
    visible.value = false;
    providerId.value = '';
    error.value = '';
    startFailure.value = null;
    providers.updating = '';
    providers.updateResults = {};
  }, { flush: 'sync' });

  return {
    snapshot,
    visible,
    providerId,
    selectedJob,
    selectedFailure,
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
