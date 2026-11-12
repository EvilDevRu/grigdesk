import type {
  InTurnDeliverResult, InTurnImage, InTurnPort,
} from '../../../../shared/chat/chatInTurnContracts.ts';
import { qwenPromptContent, type QwenImageContent } from './images.ts';

interface QueuedMessage {
  messageId: string;
  text: string;
  images: QwenImageContent[];
  settle: (result: InTurnDeliverResult) => void;
}

/**
 * Уточнения остаются в очереди своего prompt до запроса drain от CLI.
 * Send-now будит текущую генерацию; подтверждение выдаётся только при передаче текста.
 */
export function createQwenInTurn(options: {
  available: () => boolean;
  sendNow: () => Promise<unknown>;
  readImages?: (images: readonly InTurnImage[]) => Promise<QwenImageContent[]>;
}) {
  const queue: QueuedMessage[] = [];
  let closed = false;

  const port: InTurnPort = {
    /**
     * Сообщение привязано к одному живому ходу и не запускает второй prompt.
     * Отказ пробуждения удаляет ещё не переданный текст без автоматического повтора.
     */
    async deliver({ messageId, text, images = [] }) {
      if (closed || !options.available() || (images.length && !options.readImages)) {
        return {
          ok: false,
          code: 'in_turn_unavailable',
          message: 'Канал уточнений Qwen недоступен.',
        };
      }

      let imageContent: QwenImageContent[] = [];

      if (images.length) {
        try {
          imageContent = await options.readImages!(images);
        } catch (error) {
          return {
            ok: false,
            code: 'attachment_unavailable',
            message: error instanceof Error ? error.message : 'Qwen: изображение недоступно.',
          };
        }
      }

      if (closed || !options.available()) {
        return {
          ok: false,
          code: 'turn_changed',
          message: 'Активный ход Qwen завершился.',
        };
      }

      return new Promise<InTurnDeliverResult>((settle) => {
        const message = {
          messageId,
          text,
          images: imageContent,
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

    const entries = queue.splice(0);
    const messages = entries.map((entry) => {
      entry.settle({ ok: true, state: 'forwarded' });

      return `${entry.text}\n\nОтветь на уточнение отдельным сообщением до итогового ответа. `
        + 'После ответа самостоятельно вернись к ранее поставленной задаче и закончи её.';
    });

    const items = entries.map((entry, index) => ({
      messageId: entry.messageId,
      displayText: entry.text,
      content: qwenPromptContent(messages[index]!, entry.images),
    }));

    return {
      messages,
      ...(entries.some((entry) => entry.images.length) ? { items } : {}),
      hasQueuedPrompt: false,
    };
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
