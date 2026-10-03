import type {
  InTurnAssistantBlock,
  InTurnAssistantEvent,
} from '../../../../shared/chatInTurnContracts.ts';
import type { ChatAssistantMessages } from './assistantMessages.ts';

interface AssistantPublisherOptions {
  messages: ChatAssistantMessages;
  nextSequence: (runId: string) => number;
  onMessage: (block: InTurnAssistantBlock) => void;
}

// Публикация видимых ответов и барьер записи перед финалом хода.
// Адаптер может не ждать callback, поэтому ошибки сохраняются до явного flush.
export class ChatAssistantPublisher {
  private readonly messages: ChatAssistantMessages;

  private readonly nextSequence: AssistantPublisherOptions['nextSequence'];

  private readonly onMessage: AssistantPublisherOptions['onMessage'];

  private readonly writes = new Map<string, Set<Promise<void>>>();

  private readonly errors = new Map<string, Error>();

  constructor({ messages, nextSequence, onMessage }: AssistantPublisherOptions) {
    this.messages = messages;
    this.nextSequence = nextSequence;
    this.onMessage = onMessage;
  }

  /**
   * Каждый callback регистрируется до возврата адаптеру, даже если тот его не ждёт.
   * Ошибка уже завершённой записи остаётся доступной барьеру финализации.
   */
  publish(runId: string, chatKey: string, event: InTurnAssistantEvent): Promise<void> {
    const job = this.writeMessage(runId, chatKey, event);
    const jobs = this.writes.get(runId) || new Set<Promise<void>>();

    jobs.add(job);
    this.writes.set(runId, jobs);
    void job.then(
      () => jobs.delete(job),
      (error: Error) => {
        jobs.delete(job);
        this.errors.set(runId, error);
      },
    );

    return job;
  }

  /**
   * Финал ждёт все известные записи своего запуска и проверяет их результат.
   * Ошибку нельзя терять при очистке очереди: без неё pending скрывал бы потерю блока.
   */
  async flush(runId: string): Promise<void> {
    const jobs = this.writes.get(runId);

    if (jobs?.size) {
      await Promise.allSettled([...jobs]);
    }

    this.writes.delete(runId);

    const error = this.errors.get(runId);

    this.errors.delete(runId);

    if (error) {
      throw error;
    }
  }

  /**
   * Запуск окончен: после его конца адаптер ничего не допишет. Ждём начатые записи и
   * бросаем все незакрытые черновики, чтобы ни у одного исполнителя не залип «Пишет…».
   * Ошибки записи здесь не поднимаются — их отдаёт `flush` успешного финала.
   */
  async settleRun(runId: string): Promise<void> {
    const jobs = this.writes.get(runId);

    if (jobs?.size) {
      await Promise.allSettled([...jobs]);
    }

    this.writes.delete(runId);
    this.errors.delete(runId);

    for (const block of this.messages.byRun(runId)) {
      if (block.complete || block.abandoned) {
        continue;
      }

      const abandoned = await this.messages.abandon(runId, block.assistantMessageId);

      if (abandoned) {
        this.onMessage(abandoned);
      }
    }
  }

  /**
   * Sequence назначается при первом появлении блока, текст черновика живёт в памяти.
   * Завершённый блок публикуется только после устойчивой записи полного текста; брошенный —
   * после записи его последнего текста, а поздние дельты к нему уже не показываются.
   */
  private async writeMessage(runId: string, chatKey: string, event: InTurnAssistantEvent): Promise<void> {
    if (!chatKey || !event?.assistantMessageId) {
      return;
    }

    const known = this.messages.get(runId, event.assistantMessageId);

    if (event.abandoned && !event.complete) {
      await this.abandonMessage(runId, event, known);

      return;
    }

    if (!known) {
      await this.messages.begin({
        runId,
        chatKey,
        assistantMessageId: event.assistantMessageId,
        sequence: this.nextSequence(runId),
      });
    }

    if (event.complete) {
      const block = await this.messages.complete(runId, event.assistantMessageId, { text: event.text });

      if (block) {
        this.onMessage(block);
      }

      return;
    }

    const block = this.messages.get(runId, event.assistantMessageId);

    if (!block || block.abandoned) {
      return;
    }

    this.messages.setDraft(runId, event.assistantMessageId, event.text);
    this.onMessage({ ...block, text: String(event.text ?? '') });
  }

  /**
   * Обрыв относится только к уже показанному черновику: блок, которого окно не видело,
   * заводить ради отметки незачем. Повторный обрыв не публикуется второй раз.
   */
  private async abandonMessage(
    runId: string,
    event: InTurnAssistantEvent,
    known: InTurnAssistantBlock | null,
  ): Promise<void> {
    if (!known || known.complete || known.abandoned) {
      return;
    }

    const block = await this.messages.abandon(runId, event.assistantMessageId, { text: event.text });

    if (block) {
      this.onMessage(block);
    }
  }
}
