import { validTerminalInsert, validChatKey } from '../../../shared/desktop/desktopWindowContract.ts';
import { newRequestId, requestIntent } from './settingsWindowChannel.ts';
import type { SettingsWindowChannel } from './settingsWindowChannel.ts';

export interface SettingsWindowActions {
  openTerminal(insert: string): Promise<boolean>;
  openChat(chatKey: string): Promise<boolean>;
}

/**
 * Настройки передают намерение главному окну и закрываются лишь после подтверждения.
 * Неуспех оставляет форму открытой, повтор команды автоматически не выполняется.
 */
export function createSettingsWindowActions(options: {
  channel: SettingsWindowChannel;
  close: () => void;
  notify: (text: string) => void;
  timeoutMs?: number;
}): SettingsWindowActions {
  /**
   * Подтверждённое действие возвращает человеку главное окно.
   * Тишина или отказ дают одно сообщение и сохраняют текущее окно настроек.
   */
  async function complete(pending: Promise<boolean>, failure: string): Promise<boolean> {
    const ok = await pending;

    if (ok) {
      options.close();
    } else {
      options.notify(failure);
    }

    return ok;
  }

  return {
    /**
     * Строка команды проходит общий байтовый лимит и запрет управляющих клавиш.
     * Намерение вставляет текст в терминал, но не отправляет Enter.
     */
    async openTerminal(insert) {
      if (!validTerminalInsert(insert)) {
        options.notify('Команду нельзя передать в терминал основного окна.');

        return false;
      }

      return complete(requestIntent(options.channel, {
        version: 1,
        type: 'terminal-request',
        requestId: newRequestId(),
        insert,
      }, options.timeoutMs), 'Основное окно не ответило — терминал не открыт.');
    },
    /**
     * Ключ чата передаётся только через декодированное намерение.
     * Окно закрывается после переключения чата в основном документе.
     */
    async openChat(chatKey) {
      if (!validChatKey(chatKey)) {
        options.notify('Чат нельзя открыть в основном окне.');

        return false;
      }

      return complete(requestIntent(options.channel, {
        version: 1,
        type: 'open-chat-request',
        requestId: newRequestId(),
        chatKey,
      }, options.timeoutMs), 'Основное окно не ответило — чат не открыт.');
    },
  };
}
