import { validTerminalInsert, validChatKey } from '../../../../shared/desktop/desktopWindowContract.ts';

interface ActionPorts {
  requestAction(run: () => Promise<boolean>): Promise<boolean>;
  notify(text: string): void;
  openTerminal(target: { insert: string }): Promise<boolean>;
  openChat(key: string): Promise<boolean>;
}

/**
 * Команда и ключ чата проходят общую проверку до вопроса о черновике.
 * Доставка остаётся внутри того же документа; терминал получает строку без Enter.
 */
export function createSettingsActions(ports: ActionPorts) {
  return {
    openTerminal(insert: string): Promise<boolean> {
      if (!validTerminalInsert(insert)) {
        ports.notify('Команду нельзя передать в терминал.');

        return Promise.resolve(false);
      }

      return ports.requestAction(() => ports.openTerminal({ insert }));
    },
    openChat(key: string): Promise<boolean> {
      if (!validChatKey(key)) {
        ports.notify('Некорректный адрес чата.');

        return Promise.resolve(false);
      }

      return ports.requestAction(() => ports.openChat(key));
    },
  };
}
