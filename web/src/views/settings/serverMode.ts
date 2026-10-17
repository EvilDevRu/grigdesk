// Тексты карточки «Процесс Cockpit» и подтверждения перезапуска по режиму сервера.
// Сервер под приложением Кокпита не получает совета про установщик: тот запустил бы юнит рядом.

export interface ServerModeText {
  pill: string;
  tone: 'ok' | 'warn';
  modeLine: string;
  hint: string | null;
  restartConfirm: string;
}

type ServerModeName = 'desktop' | 'systemd' | 'manual';

// Команда установщика службы; карточка выделяет её внутри подсказки моноширинно.
export const SERVER_INSTALL_COMMAND = 'deploy/install.sh';

const TEXTS: Record<ServerModeName, ServerModeText> = {
  desktop: {
    pill: 'Под управлением приложения',
    tone: 'ok',
    modeLine: 'приложение Кокпита',
    hint: null,
    restartConfirm: 'Сервер перезапустит приложение Кокпита.',
  },
  systemd: {
    pill: 'Под управлением systemd',
    tone: 'ok',
    modeLine: 'демон systemd',
    hint: null,
    restartConfirm: 'Сервер выйдет, юнит systemd поднимет его сам.',
  },
  manual: {
    pill: 'Ручной запуск',
    tone: 'warn',
    modeLine: 'запущен вручную',
    hint: 'Ручной запуск — режим разработки. Чтобы демон поднимался сам, один раз выполни'
      + ` ${SERVER_INSTALL_COMMAND}. Режимы не смешивать: ручной экземпляр держит порт,`
      + ' и юнит будет падать в цикле.',
    restartConfirm: 'Сервер запущен вручную — перезапустится через deploy/restart.sh.',
  },
};

/**
 * Режим берётся из поля mode ответа /api/system/server. Без него или с незнакомым
 * значением (сервер ещё не перезапущен на новый код) — по прежнему признаку systemd.
 * Возвращается копия: вызывающий код не меняет общий справочник текстов.
 */
export function serverModeText(srv: { systemd?: boolean; mode?: string } | null): ServerModeText {
  let mode: ServerModeName = srv?.systemd ? 'systemd' : 'manual';

  if (srv?.mode === 'desktop' || srv?.mode === 'systemd' || srv?.mode === 'manual') {
    mode = srv.mode;
  }

  return { ...TEXTS[mode] };
}
