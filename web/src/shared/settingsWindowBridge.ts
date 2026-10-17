import type { SettingsWindowMessage } from '../../../shared/desktop/desktopWindowContract.ts';
import type { SettingsWindowChannel } from './settingsWindowChannel.ts';

/**
 * Главное окно объединяет частые изменения в одно следующее перечитывание.
 * Cleanup запрещает новые действия и ответы уже выполнявшихся намерений.
 */
export function createSettingsWindowBridge(options: {
  channel: SettingsWindowChannel;
  reread: () => Promise<void>;
  openTerminal: (insert: string) => Promise<boolean>;
  openChat: (chatKey: string) => Promise<boolean>;
}): { dispose(): void } {
  let live = true;
  let reading = false;
  let again = false;

  /**
   * Во время запроса любое число сообщений даёт ровно один следующий запрос.
   * Отказ не обрывает очередь, dispose снимает отложенное перечитывание.
   */
  async function reread(): Promise<void> {
    if (reading) {
      again = true;

      return;
    }

    reading = true;

    do {
      again = false;

      try {
        await options.reread();
      } catch {
        // Следующее сохранение должно работать и после отказа чтения.
      }
    } while (live && again);

    reading = false;
  }

  /**
   * Ответ отправляется только после результата действия и пока мост жив.
   * Исключение launcher или router становится отрицательным подтверждением.
   */
  async function intent(message: Extract<SettingsWindowMessage, { requestId: string }>): Promise<void> {
    let ok = false;

    try {
      if (message.type === 'terminal-request') {
        ok = await options.openTerminal(message.insert);
      } else if (message.type === 'open-chat-request') {
        ok = await options.openChat(message.chatKey);
      }
    } catch {
      ok = false;
    }

    if (live) {
      options.channel.post({
        version: 1,
        type: 'intent-result',
        requestId: message.requestId,
        ok,
      });
    }
  }

  const unsubscribe = options.channel.subscribe((message) => {
    if (!live) {
      return;
    }

    if (message.type === 'settings-changed') {
      void reread();
    } else if (message.type === 'terminal-request' || message.type === 'open-chat-request') {
      void intent(message);
    }
  });

  return {
    dispose() {
      live = false;
      again = false;
      unsubscribe();
    },
  };
}
