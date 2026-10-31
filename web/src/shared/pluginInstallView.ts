import { localeTranslator, type LocaleSource } from '../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../shared/i18n/catalogs.ts';
import type {
  PluginInstallJob,
  PluginInstallErrorInfo,
} from '../../../shared/plugins/pluginInstallContracts.ts';
import {
  isActiveInstallJob,
  installProgress,
  INSTALL_STAGE_LABELS,
  installResultText,
} from './pluginInstall.ts';

export interface InstallDialogInput {
  packageKind?: 'plugin' | 'db-engine';
  job: PluginInstallJob | null;
  mode: 'install' | 'update';
  pluginName: string | null;
  pluginLocalChanges: boolean;
  bootLoading: boolean;
  bootFailed: boolean;
  error: string | null;
  recoveryError: PluginInstallErrorInfo | null;
  pendingAction: string | null;
  reconciling: boolean;
  busy: boolean;
  versionsLoading: boolean;
  versionsInputKey: string;
  versionsUrl: string;
  url: string;
  selectedVersion: string;
  replaceModified: boolean;
}

export interface InstallDialogView {
  heading: string;
  clarifying: boolean;
  locked: boolean;
  screen: 'loading' | 'unavailable' | 'source' | 'progress' | 'ready' | 'result';
  progress: ReturnType<typeof installProgress>;
  preview: PluginInstallJob['preview'];
  stageLabel: string;
  progressHeading: string;
  activeStep: number;
  completed: boolean;
  footerHint: string;
  resultHeading: string;
  resultTone: 'success' | 'danger' | 'neutral';
  stageHeading: string;
  stageDescription: string;
  stageTone: 'success' | 'danger' | 'warning' | 'accent';
  stageIcon: string;
  canStart: boolean;
  resultText: string;
  footer: {
    primary: {
      action: 'wait' | 'reload' | 'start' | 'apply' | 'retry' | 'close';
      label: string;
      disabled: boolean;
    };
    secondary: {
      action: 'dismiss' | 'cancel' | 'close' | null;
      label: string;
      disabled: boolean;
    };
  };
}

/**
 * Сохранённое глобальное задание определяет заголовок независимо от инициатора.
 * Название карточки используется только до появления задания.
 */
function dialogHeading(input: InstallDialogInput,
  locale: LocaleSource = 'ru',
): string {
  const t = localeTranslator(locale);

  const current = input.job;
  const installHeading = input.packageKind === 'db-engine'
    ? t("settings.installingDbDriver") : t("settings.installingAPluginFromGit");

  if (current) {
    const name = current.preview?.name ?? current.pluginId ?? t("settings.plugin");

    if (current.kind === 'update') {
      return t("settings.updating", { name: name });
    }

    if (current.kind === 'rollback') {
      return t("settings.restoring", { name: name });
    }

    return installHeading;
  }

  return input.mode === 'update'
    ? t("settings.updating2", { value1: input.pluginName ?? t("settings.plugin") })
    : installHeading;
}

/**
 * Проекция воспроизводит выбор экрана, подписи и доступность действий без эффектов.
 * Открытием, запросами, закрытием и реактивным состоянием владеет компонент.
 */
export function deriveInstallDialogView(input: InstallDialogInput,
  locale: LocaleSource = 'ru',
): InstallDialogView {
  const t = localeTranslator(locale);

  const heading = dialogHeading(input, locale);
  const clarifying = input.pendingAction === 'apply' || input.reconciling;
  const locked = input.bootLoading || (!input.job && input.bootFailed && !!input.error)
    || input.busy
    || clarifying || !!input.recoveryError
    || input.job?.status === 'recovery_required';
  const screen = clarifying ? 'progress'
    : !input.job && input.bootLoading ? 'loading'
    : !input.job && input.bootFailed && input.error ? 'unavailable' : !input.job ? 'source'
    : isActiveInstallJob(input.job) ? 'progress'
    : input.job.status === 'ready' ? 'ready' : 'result';
  const progress = clarifying
    ? { value: 0, indeterminate: true } : installProgress(input.job);
  const preview = input.job?.preview ?? null;
  const stageLabel = input.job?.stage ? t(`settings.installStage.${input.job.stage}`) : '';
  const progressHeading = clarifying ? t("settings.checkingOutcome")
    : input.job?.status === 'applying' ? t("settings.applyingChanges") : stageLabel;
  const activeStep = !input.job ? 0
    : input.job.status === 'running' || input.job.stage || !input.job.preview ? 1 : 2;
  const completed = input.job?.status === 'done';
  const footerHint = screen === 'source' ? t("settings.installationStartsOnlyAfterConfirmation")
    : screen === 'ready' ? t("settings.verifyTheSourceBeforeInstallation")
    : screen === 'progress' ? t("settings.closingTheWindowDoesNotCancelInstallation")
    : completed ? t("settings.changesSavedInGrigDesk")
    : screen === 'result' ? t("settings.operationResultSaved") : t("settings.checkingInstallationStatus");
  const resultHeading = completed
    ? input.job?.kind === 'rollback' ? t("settings.versionRestored") : t("settings.installationComplete")
    : input.job?.status === 'cancelled' ? t("settings.installationCancelled2")
    : input.job?.status === 'recovery_required' ? t("settings.recoveryRequired2")
    : input.job?.status === 'interrupted'
      ? t("settings.installationInterrupted") : t("settings.installationNotCompleted");
  const resultTone = input.job?.status === 'done' ? 'success'
    : input.job?.status === 'failed' ? 'danger' : 'neutral';
  const stageHeading = screen === 'loading' ? t("settings.checkingStatus")
    : screen === 'unavailable' ? t("settings.noConnectionToGrigDesk")
    : screen === 'source'
      ? input.mode === 'update' ? t("settings.selectANewVersion") : t("settings.connectARepository")
    : screen === 'progress' ? progressHeading
    : screen === 'ready' ? t("settings.readyToInstall") : resultHeading;
  const stageDescription = screen === 'loading' ? t("settings.lookingForAnUnfinishedInstallation")
    : screen === 'unavailable' ? t("settings.retryLoadingToContinue")
    : screen === 'source' ? t("settings.findTheReleaseYouWantToInstall")
    : screen === 'progress' ? t("settings.workContinuesEvenIfTheWindowIs")
    : screen === 'ready' ? t("settings.reviewThePackageAndConfirmTheChanges")
    : completed ? input.packageKind === 'db-engine'
      ? t("settings.driverSavedRestart") : t("settings.pluginSavedNextStepsAreBelow")
    : input.job?.status === 'cancelled' ? t("settings.youCanCloseTheWindowAndReturn")
    : t("settings.operationDetailsAreBelow");
  const stageTone = completed ? 'success'
    : screen === 'unavailable' || input.job?.status === 'failed' ? 'danger'
    : input.job?.status === 'recovery_required' ? 'warning' : 'accent';
  const stageIcon = completed || screen === 'ready' ? 'm5 12 4 4L19 6'
    : screen === 'result' || screen === 'unavailable' ? 'M12 5v9m0 3v2'
    : 'M7 7v10m0-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z'
      + 'm0-6h5a5 5 0 0 0 5-5V7m0 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z';
  const canStart = screen === 'source' && !!input.selectedVersion
    && !locked && !input.versionsLoading
    && input.versionsInputKey === input.url.trim() && !!input.versionsUrl
    && !(input.mode === 'update' && input.pluginLocalChanges && !input.replaceModified);

  const primaryAction = screen === 'loading' ? 'wait' : screen === 'unavailable' ? 'reload'
    : screen === 'source' ? 'start' : screen === 'ready' ? 'apply'
    : screen === 'result' && input.job?.status === 'failed' ? 'retry' : 'close';
  const primaryLabel = primaryAction === 'wait' ? t("settings.checkingStatus")
    : primaryAction === 'reload' ? t("settings.retryLoading")
    : primaryAction === 'start' ? t("settings.downloadAndVerify")
    : primaryAction === 'apply'
      ? input.job?.kind === 'update' || preview?.replaces.kind === 'managed'
        ? t("settings.update") : t("settings.install")
    : primaryAction === 'retry'
      ? t("settings.tryAgain") : completed ? t("settings.done") : t("settings.close");
  const primaryDisabled = primaryAction === 'wait' || (primaryAction === 'start' && !canStart)
    || (primaryAction === 'apply' || primaryAction === 'retry') && locked;
  const secondaryAction = ['source', 'loading', 'unavailable'].includes(screen) ? 'dismiss'
    : screen === 'ready' || screen === 'progress' && !clarifying && input.job?.status === 'running'
      ? 'cancel' : screen === 'result' && input.job?.status === 'failed' ? 'close' : null;
  const secondaryLabel = secondaryAction === 'dismiss' ? t("settings.cancel")
    : secondaryAction === 'cancel'
      ? t("settings.cancel2") : secondaryAction === 'close' ? t("settings.close") : '';

  return {
    heading,
    clarifying,
    locked,
    screen,
    progress,
    preview,
    stageLabel,
    progressHeading,
    activeStep,
    completed,
    footerHint,
    resultHeading,
    resultTone,
    stageHeading,
    stageDescription,
    stageTone,
    stageIcon,
    canStart,
    resultText: input.job ? installResultText(input.job, locale, input.packageKind) : '',
    footer: {
      primary: {
        action: primaryAction,
        label: primaryLabel,
        disabled: primaryDisabled,
      },
      secondary: {
        action: secondaryAction,
        label: secondaryLabel,
        disabled: secondaryAction === 'cancel' && locked,
      },
    },
  };
}
