import { localeMessage, type LocaleSource } from '../../../../shared/i18n/catalogs.ts';
import type { UiText } from '../../../../shared/i18n/core.ts';
import { validTerminalInsert, validChatKey } from '../../../../shared/desktop/desktopWindowContract.ts';

interface ActionPorts {
  requestAction(run: () => Promise<boolean>): Promise<boolean>;
  notify(text: UiText): void;
  openTerminal(target: { insert: string }): Promise<boolean>;
  openChat(key: string): Promise<boolean>;
}

/**
 * Команда и ключ чата проходят общую проверку до вопроса о черновике.
 * Доставка остаётся внутри того же документа; терминал получает строку без Enter.
 */
export function createSettingsActions(ports: ActionPorts,
  locale: LocaleSource = 'ru',
) {
  const message = localeMessage(locale);

  return {
    openTerminal(insert: string): Promise<boolean> {
      if (!validTerminalInsert(insert)) {
        ports.notify(message('settings.cannotSendTheCommandToTheTerminal'));

        return Promise.resolve(false);
      }

      return ports.requestAction(() => ports.openTerminal({ insert }));
    },
    openChat(key: string): Promise<boolean> {
      if (!validChatKey(key)) {
        ports.notify(message('settings.invalidChatAddress'));

        return Promise.resolve(false);
      }

      return ports.requestAction(() => ports.openChat(key));
    },
  };
}
