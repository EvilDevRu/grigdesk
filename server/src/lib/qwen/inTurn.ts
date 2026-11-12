import type {
  InTurnDeliverResult, InTurnPort,
} from '../../../../shared/chat/chatInTurnContracts.ts';

interface QueuedMessage {
  messageId: string;
  text: string;
  settle: (result: InTurnDeliverResult) => void;
}

/**
 * Уточнения остаются в очереди своего prompt до запроса drain от CLI.
 * Send-now будит текущую генерацию; подтверждение выдаётся только при передаче текста.
 */
export function createQwenInTurn(options: {
  available: () => boolean;
  sendNow: () => Promise<unknown>;
}) {
  const queue: QueuedMessage[] = [];
  let closed = false;

  const port: InTurnPort = {
    /**
     * Сообщение привязано к одному живому ходу и не запускает второй prompt.
     * Отказ пробуждения удаляет ещё не переданный текст без автоматического повтора.
     */
    async deliver({ messageId, text, images = [] }) {
      if (closed || !options.available() || images.length) {
        return {
          ok: false,
          code: 'in_turn_unavailable',
          message: 'Канал уточнений Qwen недоступен.',
        };
      }

      return new Promise<InTurnDeliverResult>((settle) => {
        const message = {
          messageId,
          text,
          settle,
        };

        queue.push(message);
        void Promise.resolve().then(() => {
          if (!closed) {
            return options.sendNow();
          }
        }).catch(() => {
          const index = queue.indexOf(message);

          if (index < 0) {
            return;
          }

          queue.splice(index, 1);
          settle({
            ok: false,
            code: 'qwen_in_turn_send_failed',
            message: 'Qwen не принял уточнение. Проверьте совместимость установленного CLI.',
          });
        });
      });
    },
    close,
  };

  /**
   * Вызывается только после проверки sessionId и promptId в runtime.
   * Повторный drain пуст: один текст нельзя включить в контекст дважды.
   */
  function drain() {
    if (closed || !options.available()) {
      return { messages: [], hasQueuedPrompt: false };
    }

    const messages = queue.splice(0).map((entry) => {
      entry.settle({ ok: true, state: 'forwarded' });

      return `${entry.text}\n\nОтветь на уточнение отдельным сообщением до итогового ответа. `
        + 'После ответа самостоятельно вернись к ранее поставленной задаче и закончи её.';
    });

    return { messages, hasQueuedPrompt: false };
  }

  /**
   * Завершение и отмена снимают ожидание всех ещё не переданных сообщений.
   * Очередь не переживает ход и не переносится в новую native-сессию.
   */
  function close() {
    closed = true;

    for (const entry of queue.splice(0)) {
      entry.settle({
        ok: false,
        code: 'turn_changed',
        message: 'Активный ход Qwen завершился.',
      });
    }
  }

  return {
    port,
    drain,
    close,
  };
}
