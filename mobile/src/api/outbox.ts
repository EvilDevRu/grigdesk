import { ApiClient, ApiError, messageIntent } from './client.ts';
import { decodeAccepted } from './contract.ts';
import type { OperationIntent } from '../link/types.ts';

export type OutboxItem = OperationIntent & {
  state: 'sending' | 'checking' | 'waiting' | 'previous' | 'failed';
  error?: string;
};

/**
 * Порядок отправки принадлежит одному владельцу на чат, а native хранит intent до сети.
 * Неопределённый ACK первого сообщения удерживает второе; нового clientId при повторе нет.
 */
export class ChatOutbox {
  items: OutboxItem[] = [];
  private api: ApiClient;
  private changed: () => void;
  private active = new Map<string, Promise<void>>();
  private epoch = 0;
  private restoredGeneration = -1;

  constructor(api: ApiClient, changed: () => void = () => {}) {
    this.api = api;
    this.changed = changed;
  }

  /**
   * Сохранение завершается до начала POST и до подтверждения очистки composer.
   * Ограничение 100/2 МиБ проверяется native, поэтому смерть JS не теряет очередь.
   */
  async enqueue(chatId: string, text: string) {
    const intent = messageIntent(chatId, text);
    const captured = this.epoch;

    await this.api.link.putOutbox({ item: intent });

    if (captured !== this.epoch) {
      return;
    }

    this.items.push({
      ...intent,
      state: this.items.some((item) => item.chatId === chatId) ? 'previous' : 'sending',
    });
    this.changed();
    void this.flush(chatId);
  }

  /**
   * Восстановление использует прежние native intent, не формируя новые ключи.
   * До повторного POST проверяется общий deliveries ledger и durable operation result.
   */
  async restore() {
    const generation = (await this.api.link.getState()).generation;

    if (this.restoredGeneration === generation) {
      return;
    }

    this.restoredGeneration = generation;

    const captured = this.epoch;
    let result;

    try {
      result = await this.api.link.getOutbox();
    } catch (error) {
      this.restoredGeneration = -1;

      throw error;
    }

    if (captured !== this.epoch) {
      return;
    }

    this.items = result.items
      .filter((item) => item.clientId && item.chatId)
      .map(
        (item) =>
          this.items.find((current) => current.idempotencyKey === item.idempotencyKey) || {
            ...item,
            state: 'checking' as const,
          },
      )
      .concat(
        this.items.filter(
          (item) => !result.items.some((entry) => entry.idempotencyKey === item.idempotencyKey),
        ),
      );
    this.changed();
    await Promise.all(
      [...new Set(this.items.map((item) => item.chatId!))].map((id) => this.flush(id)),
    );
  }

  /**
   * Flush не создаёт параллельных отправителей и прекращается после lock/generation смены.
   * Удаление intent разрешено после durable proof приёма, до отправки следующего сообщения.
   */
  flush(chatId: string): Promise<void> {
    const previous = this.active.get(chatId);

    if (previous) {
      return previous;
    }

    const captured = this.epoch;
    const work = (async () => {
      while (captured === this.epoch) {
        const item = this.items.find((candidate) => candidate.chatId === chatId);

        if (!item || item.state === 'failed') {
          return;
        }

        try {
          if (['checking', 'waiting'].includes(item.state)) {
            const proof = await this.verify(item);

            if (proof === 'unknown') {
              item.state = 'checking';
              this.changed();

              return;
            }
            if (proof === 'accepted') {
              await this.accepted(item, captured);

              continue;
            }
          }

          item.state = 'sending';
          this.changed();
          await this.api.sendMessage(chatId, '', item);
          await this.accepted(item, captured);
        } catch (error) {
          if (captured !== this.epoch) {
            return;
          }

          const failure =
            error instanceof ApiError ? error : new ApiError(0, 'network', 'Нет связи с Кокпитом.');

          // Просроченный приём сервер отвечает только на ключ, которого не видел: эффекта не было,
          // а повтор с тем же ключом снова просрочен. Решение о сообщении остаётся человеку.
          item.state =
            failure.code === 'network'
              ? 'waiting'
              : ['operation_pending', 'operation_unknown'].includes(failure.code) ||
                  failure.status >= 500
                ? 'checking'
                : 'failed';
          item.error =
            failure.code === 'operation_expired'
              ? 'Связь вернулась слишком поздно, сообщение не отправлено. Отправьте его заново.'
              : failure.message;
          this.changed();

          return;
        }
      }
    })().finally(() => {
      if (this.active.get(chatId) === work) {
        this.active.delete(chatId);
      }
    });

    this.active.set(chatId, work);

    return work;
  }

  /**
   * ready сначала ждёт прежнего отправителя, затем проверяет durable delivery/journal.
   * Повтор после сети использует тот же intent и не конкурирует с ещё заканчивающимся POST.
   */
  async reconnect() {
    const captured = this.epoch;
    const chats = [...new Set(this.items.map((item) => item.chatId!))];

    await Promise.all(
      chats.map(async (id) => {
        await this.active.get(id);

        if (captured === this.epoch) {
          await this.flush(id);
        }
      }),
    );
  }

  /**
   * Явный отказ можно убрать из очереди; неоднозначную операцию убрать этим способом нельзя.
   * Следующее сообщение допускается только после решения пользователя о неотправленном.
   */
  async discard(item: OutboxItem) {
    if (item.state !== 'failed') {
      return;
    }

    await this.api.link.removeOutbox({ idempotencyKey: item.idempotencyKey });
    this.items = this.items.filter((candidate) => candidate !== item);
    this.changed();
    void this.flush(item.chatId!);
  }

  /**
   * Lock очищает только экранное представление и отменяет прежних отправителей.
   * Намерения остаются в native файле и сверяются после нового unlock.
   */
  clear() {
    this.epoch += 1;
    this.active.clear();
    this.restoredGeneration = -1;
    this.items = [];
    this.changed();
  }

  /**
   * Точный серверный proof принимается раньше результата HTTP, который мог потеряться.
   * Unknown/pending не запускает эффект повторно; отсутствие intent допускает прежний key.
   */
  private async verify(item: OutboxItem): Promise<'accepted' | 'retry' | 'unknown'> {
    const delivery = await this.api.getDeliveries(item.chatId!, [item.clientId!]);

    if (
      delivery.deliveries.some(
        (entry) => entry.clientId === item.clientId && entry.state !== 'unknown',
      )
    ) {
      return 'accepted';
    }

    const operation = await this.api.getOperation(item.idempotencyKey);

    if (operation.state === 'done' && operation.result) {
      if (operation.result.status === 202 && !(operation.result.body as any)?.operationPending) {
        const result = decodeAccepted(operation.result.body);

        return result.clientId === item.clientId ? 'accepted' : 'unknown';
      }
      if (operation.result.status >= 400 && operation.result.status < 500) {
        throw new ApiError(
          operation.result.status,
          String((operation.result.body as any)?.error || 'rejected'),
          String((operation.result.body as any)?.message || 'Сообщение не принято.'),
          item,
        );
      }
    }

    return operation.state === 'not_found' && Date.now() - item.createdAt < 24 * 60 * 60 * 1000
      ? 'retry'
      : 'unknown';
  }

  /**
   * Durable intent снимается после доказательства приёма общего чата.
   * Callback старой сессии очищает только её intent и не меняет новый экран после lock.
   */
  private async accepted(item: OutboxItem, captured: number) {
    await this.api.link.removeOutbox({ idempotencyKey: item.idempotencyKey });

    if (captured === this.epoch) {
      this.items = this.items.filter((candidate) => candidate !== item);
      this.changed();
    }
  }
}
