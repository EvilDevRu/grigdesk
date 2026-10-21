import { localeTranslator, resolveLocaleText, type LocaleSource } from '../../../../shared/i18n/catalogs.ts';
import { messageRef, type MessageRef } from '../../../../shared/i18n/core.ts';
// Тексты карточки «Процесс GrigDesk» и подтверждения перезапуска по режиму сервера.
// Сервер под приложением GrigDesk не получает совета про установщик: тот запустил бы юнит рядом.

export interface ServerModeText {
  pill: string;
  tone: 'ok' | 'warn';
  modeLine: string;
  hint: string | null;
  restartConfirm: string;
}

type ServerModeName = 'desktop' | 'systemd' | 'manual';
type ServerModeInfo = { systemd?: boolean; mode?: string } | null;

// Команда установщика службы; карточка выделяет её внутри подсказки моноширинно.
export const SERVER_INSTALL_COMMAND = 'deploy/install.sh';

/**
 * Признанный mode имеет приоритет над прежним признаком systemd.
 * Неизвестный режим старого сервера сохраняет прежнюю совместимость карточки.
 */
function serverMode(srv: ServerModeInfo): ServerModeName {
  if (srv?.mode === 'desktop' || srv?.mode === 'systemd' || srv?.mode === 'manual') {
    return srv.mode;
  }

  return srv?.systemd ? 'systemd' : 'manual';
}

/**
 * Открытый вопрос удерживает режим сервера как descriptor, а не готовый перевод.
 * Смена языка поэтому обновляет пояснение без повторного чтения состояния сервера.
 */
export function serverRestartMessage(srv: ServerModeInfo): MessageRef {
  const mode = serverMode(srv);

  if (mode === 'desktop') {
    return messageRef('settings.theGrigDeskApplicationWillRestartTheServer');
  }

  if (mode === 'systemd') {
    return messageRef('settings.theServerWillExitAndTheSystemd');
  }

  return messageRef('settings.theServerWasStartedManuallyItWill');
}

/**
 * Режим берётся из поля mode ответа /api/system/server. Без него или с незнакомым
 * значением (сервер ещё не перезапущен на новый код) — по прежнему признаку systemd.
 * Возвращается копия: вызывающий код не меняет общий справочник текстов.
 */
export function serverModeText(srv: { systemd?: boolean; mode?: string } | null,
  locale: LocaleSource = 'ru',
): ServerModeText {
  const t = localeTranslator(locale);
  const restartConfirm = resolveLocaleText(serverRestartMessage(srv), locale);
  const TEXTS: Record<ServerModeName, ServerModeText> = {
    desktop: {
      pill: t("settings.managedByApplication"),
      tone: 'ok',
      modeLine: t("settings.grigdeskApplication"),
      hint: null,
      restartConfirm,
    },
    systemd: {
      pill: t("settings.managedBySystemd"),
      tone: 'ok',
      modeLine: t("settings.systemdDaemon"),
      hint: null,
      restartConfirm,
    },
    manual: {
      pill: t("settings.manualStartup"),
      tone: 'warn',
      modeLine: t("settings.startedManually"),
      hint: t("settings.manualStartupIsDevelopmentModeToStart")
        + t("settings.doNotMixModesTheManualInstance", { SERVER_INSTALL_COMMAND: SERVER_INSTALL_COMMAND })
        + t("settings.andTheUnitWillFailRepeatedly"),
      restartConfirm,
    },
  };


  return { ...TEXTS[serverMode(srv)] };
}
