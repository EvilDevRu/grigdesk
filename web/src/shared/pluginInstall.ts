import { localeTranslator, type LocaleSource } from '../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../shared/i18n/catalogs.ts';
import type {
  PluginInstallJob,
  PluginInstallStage,
  PluginInstallReplaces,
} from '../../../shared/plugins/pluginInstallContracts.ts';
import type { PluginListItem } from '../../../shared/plugins/pluginsContracts.ts';

/**
 * Активное задание продолжает polling и показывает ход операции.
 * Ready и recovery имеют отдельные действия и не означают работающий worker.
 */
export function isActiveInstallJob(job: PluginInstallJob | null | undefined): boolean {
  return job?.status === 'running' || job?.status === 'applying';
}

/**
 * Terminal outcome можно прочитать и явно скрыть, сохранив серверную историю.
 * Recovery не разрешает забыть задание и начать новую замену поверх него.
 */
export function isTerminalInstallJob(job: PluginInstallJob | null | undefined): boolean {
  return ['done', 'failed', 'cancelled', 'interrupted'].includes(job?.status ?? '');
}

export const INSTALL_STAGE_ORDER: PluginInstallStage[] = ['fetching', 'validating', 'dependencies'];
export const INSTALL_STAGE_LABELS: Record<PluginInstallStage, string> = {
  fetching: t("settings.downloadingFromSource"),
  validating: t("settings.verifyingPackage"),
  dependencies: t("settings.installingDependencies"),
};

export interface PluginInstallStageRow {
  id: PluginInstallStage;
  label: string;
  state: 'done' | 'current' | 'pending' | 'failed';
}

/**
 * Список шагов отражает только подтверждённый status и место выполнения.
 * Recovery и отмена не обещают законченных шагов после остановки задания.
 */
export function installStageRows(
  job: PluginInstallJob,
  locale: LocaleSource = 'ru',
): PluginInstallStageRow[] {
  const current = job.stage ? INSTALL_STAGE_ORDER.indexOf(job.stage) : -1;
  const completed = ['ready', 'applying', 'done'].includes(job.status);

  return INSTALL_STAGE_ORDER.map((id, index) => {
    let state: PluginInstallStageRow['state'] = 'pending';

    if (completed || job.status !== 'recovery_required' && index < current) {
      state = 'done';
    } else if (index === current && job.status === 'running') {
      state = 'current';
    } else if (index === current && job.status === 'failed') {
      state = 'failed';
    }

    return {
      id,
      label: localeTranslator(locale)(`settings.installStage.${id}`),
      state,
    };
  });
}

/**
 * Процент относится только к измеряемому fetching, остальные эффекты неопределённы.
 * Terminal failure и recovery не рисуют обещание завершённой установки.
 */
export function installProgress(job: PluginInstallJob | null): {
  value: number;
  indeterminate: boolean;
} | null {
  if (!job) {
    return null;
  }

  if (job.status === 'ready' || job.status === 'done') {
    return { value: 100, indeterminate: false };
  }

  if (!isActiveInstallJob(job)) {
    return null;
  }

  const measured = job.status === 'running' && job.stage === 'fetching'
    && typeof job.percent === 'number' && Number.isFinite(job.percent);

  return {
    value: measured ? job.percent ?? 0 : 0,
    indeterminate: !measured,
  };
}

/**
 * Итог различает новую установку, обновление и восстановленный snapshot.
 * Ошибка и recovery показывают безопасный серверный текст вместе с причиной блокировки.
 */
export function installResultText(job: PluginInstallJob,
  locale: LocaleSource = 'ru',
): string {
  const t = localeTranslator(locale);

  const name = job.preview?.name ?? job.pluginId ?? t("settings.plugin");
  const version = job.target?.version ?? '';

  if (job.status === 'done') {
    if (job.kind === 'rollback') {
      return t("settings.versionVRestoredRestartGrigDesk", { version: version });
    }

    if (job.preview?.replaces.kind === 'none') {
      return t("settings.pluginVInstalledEnableItInThe", { name: name, version: version });
    }

    return t("settings.pluginUpdatedToVRestartGrigDeskTo", { name: name, version: version });
  }

  if (job.status === 'failed') {
    return job.error?.message ?? t("settings.installationFailed");
  }

  if (job.status === 'cancelled') {
    return t("settings.installationCancelled");
  }

  if (job.status === 'interrupted') {
    return job.error?.message ?? t("settings.theServerRestartedDuringInstallationStartAgain");
  }

  if (job.status === 'recovery_required') {
    return t("settings.caption", { value1: job.error?.message ?? t("settings.recoveryRequired") })
      + t("settings.copiesSavedNewInstallationIsCurrentlyUnavailable");
  }

  return '';
}

/**
 * Короткая подпись объясняет исход прежней копии при конкретном preview.
 * Смена source и ручная папка видны до подтверждения установки.
 */
export function replacesText(replaces: PluginInstallReplaces,
  locale: LocaleSource = 'ru',
): string {
  const t = localeTranslator(locale);

  if (replaces.kind === 'none') {
    return t("settings.newPlugin");
  }

  if (replaces.kind === 'managed') {
    return t("settings.willReplaceInstalledV", { replacesVersion: replaces.version })
      + (replaces.sourceChanged ? t("settings.sourceWillChange") : '');
  }

  return t("settings.willReplaceTheManuallyPlacedFolderIt");
}

/**
 * Restart показывает уже опубликованную версию, которую runtime ещё не использует.
 * Отсутствующее install у прежнего сервера и manual plugin безопасно остаётся без badge.
 */
export function pluginInstallBadge(plugin: PluginListItem): 'update' | 'restart' | '' {
  if (plugin.install?.restartRequired) {
    return 'restart';
  }

  return plugin.install?.updateAvailable ? 'update' : '';
}

/**
 * Короткий SHA нужен только подписи списка коммитов и установленной версии.
 * Preview перед подтверждением показывает полный проверенный SHA отдельно.
 */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
