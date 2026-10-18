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
function dialogHeading(input: InstallDialogInput): string {
  const current = input.job;

  if (current) {
    const name = current.preview?.name ?? current.pluginId ?? 'плагин';

    if (current.kind === 'update') {
      return `Обновление «${name}»`;
    }

    if (current.kind === 'rollback') {
      return `Восстановление «${name}»`;
    }

    return 'Установка плагина из Git';
  }

  return input.mode === 'update' ? `Обновление «${input.pluginName ?? 'плагин'}»`
    : 'Установка плагина из Git';
}

/**
 * Проекция воспроизводит выбор экрана, подписи и доступность действий без эффектов.
 * Открытием, запросами, закрытием и реактивным состоянием владеет компонент.
 */
export function deriveInstallDialogView(input: InstallDialogInput): InstallDialogView {
  const heading = dialogHeading(input);
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
  const stageLabel = input.job?.stage ? INSTALL_STAGE_LABELS[input.job.stage] : '';
  const progressHeading = clarifying ? 'Уточняю исход'
    : input.job?.status === 'applying' ? 'Применяем изменения' : stageLabel;
  const activeStep = !input.job ? 0
    : input.job.status === 'running' || input.job.stage || !input.job.preview ? 1 : 2;
  const completed = input.job?.status === 'done';
  const footerHint = screen === 'source' ? 'Установка — только после подтверждения.'
    : screen === 'ready' ? 'Проверьте источник перед установкой.'
    : screen === 'progress' ? 'Закрытие окна не отменяет установку.'
    : completed ? 'Изменения сохранены в GrigDesk.'
    : screen === 'result' ? 'Результат операции сохранён.' : 'Проверяем состояние установки.';
  const resultHeading = completed
    ? input.job?.kind === 'rollback' ? 'Версия восстановлена' : 'Установка завершена'
    : input.job?.status === 'cancelled' ? 'Установка отменена'
    : input.job?.status === 'recovery_required' ? 'Требуется восстановление'
    : input.job?.status === 'interrupted' ? 'Установка прервана' : 'Установка не выполнена';
  const resultTone = input.job?.status === 'done' ? 'success'
    : input.job?.status === 'failed' ? 'danger' : 'neutral';
  const stageHeading = screen === 'loading' ? 'Проверяем состояние'
    : screen === 'unavailable' ? 'Нет связи с GrigDesk'
    : screen === 'source' ? input.mode === 'update' ? 'Выберите новую версию' : 'Подключите репозиторий'
    : screen === 'progress' ? progressHeading
    : screen === 'ready' ? 'Всё готово к установке' : resultHeading;
  const stageDescription = screen === 'loading' ? 'Ищем незавершённую установку.'
    : screen === 'unavailable' ? 'Повторите загрузку, чтобы продолжить.'
    : screen === 'source' ? 'Найдите релиз, который хотите установить.'
    : screen === 'progress' ? 'Работа продолжится, даже если закрыть окно.'
    : screen === 'ready' ? 'Проверьте пакет и подтвердите изменения.'
    : completed ? 'Плагин сохранён. Ниже — дальнейшие действия.'
    : input.job?.status === 'cancelled' ? 'Можно закрыть окно и вернуться к каталогу.'
    : 'Подробности операции приведены ниже.';
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
  const primaryLabel = primaryAction === 'wait' ? 'Проверяем состояние'
    : primaryAction === 'reload' ? 'Повторить загрузку'
    : primaryAction === 'start' ? 'Скачать и проверить'
    : primaryAction === 'apply'
      ? input.job?.kind === 'update' || preview?.replaces.kind === 'managed' ? 'Обновить' : 'Установить'
    : primaryAction === 'retry' ? 'Попробовать снова' : completed ? 'Готово' : 'Закрыть';
  const primaryDisabled = primaryAction === 'wait' || (primaryAction === 'start' && !canStart)
    || (primaryAction === 'apply' || primaryAction === 'retry') && locked;
  const secondaryAction = ['source', 'loading', 'unavailable'].includes(screen) ? 'dismiss'
    : screen === 'ready' || screen === 'progress' && !clarifying && input.job?.status === 'running'
      ? 'cancel' : screen === 'result' && input.job?.status === 'failed' ? 'close' : null;
  const secondaryLabel = secondaryAction === 'dismiss' ? 'Отмена'
    : secondaryAction === 'cancel' ? 'Отменить' : secondaryAction === 'close' ? 'Закрыть' : '';

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
    resultText: input.job ? installResultText(input.job) : '',
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
