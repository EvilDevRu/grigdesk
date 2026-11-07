// Приём, порядок и передача уточнений конкретному запуску.
//
// Координатор знает только про порт адаптера: он не ветвится по вендору и не держит
// блокировку чата. Уточнение получает sequence при приёме, состояние пишется в durable
// журнал до внешнего эффекта, а доставка идёт отдельной последовательной задачей, чтобы
// «стоп» и закрытие приёма оставались доступны во время ожидания транспорта.
import {
  IN_TURN_ACTIVE_LIMIT,
  IN_TURN_ACTIVE_TEXT_LIMIT,
  IN_TURN_ATTACHMENT_LIMIT,
  IN_TURN_BACKLOG_LIMIT,
  IN_TURN_ID_RE,
  IN_TURN_PAGE_LIMIT,
  IN_TURN_PAGE_TEXT_LIMIT,
  IN_TURN_TEXT_LIMIT_BYTES,
  IN_TURN_SEGMENT_RE,
  inTurnFingerprint,
  isPendingDelivery,
  utf8Bytes,
} from '../../../../shared/chat/chatInTurnContracts.ts';
import type {
  InTurnAssistantBlock,
  InTurnAttachment,
  InTurnAvailability,
  InTurnPage,
  InTurnPort,
  InTurnReceipt,
  InTurnReceiptEvent,
  InTurnUnavailableReason,
} from '../../../../shared/chat/chatInTurnContracts.ts';
import type { ChatAssistantMessages } from './assistantMessages.ts';
import type { ChatInTurnLedger, InTurnRecord } from './inTurnLedger.ts';

export interface InTurnAcceptInput {
  chatKey: string;
  runId: string;
  messageId: string;
  text: string;
  attachments?: InTurnAttachment[];
  sentAt?: number;
  context?: unknown;
}

export type InTurnAcceptResult =
  | { ok: true; receipt: InTurnReceipt }
  | {
    ok: false;
    status: number;
    code: string;
    message: string;
    reason?: InTurnUnavailableReason;
  };

export type InTurnChangeEvent =
  | {
    kind: 'receipt';
    chatKey: string;
    runId: string;
    messageId: string;
    state: string;
  }
  | {
    kind: 'assistant';
    chatKey: string;
    runId: string;
    assistantMessageId: string;
    complete: boolean;
  }
  | {
    kind: 'ready';
    chatKey: string;
    runId: string;
    available: boolean;
    reason?: InTurnUnavailableReason;
  };

interface RunState {
  chatKey: string;
  runId: string;
  parentTurnId?: string;
  images: boolean;
  availability: InTurnAvailability;
  sequence: number;
  revision: number;
  port: InTurnPort | null;
  closing: boolean;
  closed: boolean;
  delivery: Promise<void>;
  waiters: Array<() => void>;
}

const CLOSED_REPLY = 'Ход завершился до передачи сообщения.';

/**
 * Отметка «run ещё активен» для восстановления: координатор живёт в памяти, а журнал
 * переживает падение, поэтому startup-проход спрашивает именно память.
 */
export class InTurnMessages {
  readonly ledger: ChatInTurnLedger;

  readonly assistant: ChatAssistantMessages;

  private readonly now: () => number;

  private readonly onChange: ((event: InTurnChangeEvent) => void) | null;

  private readonly runs = new Map<string, RunState>();

  constructor({
    ledger,
    assistant,
    now = () => Date.now(),
    onChange = null,
  }: {
    ledger: ChatInTurnLedger;
    assistant: ChatAssistantMessages;
    now?: () => number;
    onChange?: ((event: InTurnChangeEvent) => void) | null;
  }) {
    this.ledger = ledger;
    this.assistant = assistant;
    this.now = now;
    this.onChange = onChange;
  }

  /**
   * Новый запуск: канал закрыт до тех пор, пока адаптер не зарегистрирует готовый порт.
   * Идентификаторы проверяются здесь же — по ним строятся пути durable-журналов.
   */
  beginRun(options: {
    chatKey: string;
    runId: string;
    parentTurnId?: string;
    images?: boolean;
  }): void {
    if (!IN_TURN_SEGMENT_RE.test(options.chatKey) || !IN_TURN_ID_RE.test(options.runId)) {
      throw new Error('in_turn_bad_run_identity');
    }

    this.runs.set(options.runId, {
      chatKey: options.chatKey,
      runId: options.runId,
      ...(options.parentTurnId ? { parentTurnId: options.parentTurnId } : {}),
      images: options.images === true,
      availability: {
        runId: options.runId,
        available: false,
        reason: 'not_ready',
        revision: 1,
      },
      sequence: 0,
      revision: 0,
      port: null,
      closing: false,
      closed: false,
      delivery: Promise.resolve(),
      waiters: [],
    });
  }

  hasRun(runId: string): boolean {
    const run = this.runs.get(runId);

    return !!run && !run.closed;
  }

  availability(runId: string): InTurnAvailability | null {
    const run = this.runs.get(runId);

    return run ? { ...run.availability } : null;
  }

  /**
   * Чат запуска. После рестарта RunState в памяти уже нет, а записи живут в журналах,
   * поэтому имя чата добирается из первичных источников — иначе GET по runId отвечал бы 404.
   */
  chatKeyOf(runId: string): string | null {
    const live = this.runs.get(runId);

    if (live) {
      return live.chatKey;
    }

    const fromLedger = this.ledger.byRun(runId)[0]?.chatKey;
    const fromAssistant = this.assistant.byRun(runId)[0]?.chatKey;

    return fromLedger || fromAssistant || null;
  }

  /**
   * Порт готовности транспорта. Регистрация открывает канал; повторная регистрация тем же
   * запуском заменяет порт, а порт старого запуска сюда попасть не может — он привязан к runId.
   */
  registerPort(runId: string, port: InTurnPort): void {
    const run = this.runs.get(runId);

    if (!run || run.closed) {
      port.close?.('run_closed');

      return;
    }

    run.port = port;
    this.setAvailability(runId, true);
  }

  /**
   * Готовность меняется и после старта, например когда агент ждёт ответа на вопрос.
   * Ревизия растёт только на настоящем изменении, поэтому позднее событие с прежней
   * ревизией не открывает закрытый канал.
   */
  setAvailability(runId: string, available: boolean, reason?: InTurnUnavailableReason): void {
    const run = this.runs.get(runId);

    if (!run || run.closed) {
      return;
    }

    const changed = run.availability.available !== available
      || (run.availability.reason || '') !== (reason || '');

    if (!changed) {
      return;
    }

    run.availability = {
      runId,
      available,
      ...(reason ? { reason } : {}),
      revision: run.availability.revision + 1,
    };
    this.wake(run);
    this.onChange?.({
      kind: 'ready',
      chatKey: run.chatKey,
      runId,
      available,
      ...(reason ? { reason } : {}),
    });
  }

  /**
   * Следующий номер в общей последовательности запуска: уточнения и блоки ответов делят
   * одну нумерацию, иначе окно не восстановит их чередование после перезагрузки.
   */
  nextSequence(runId: string): number {
    const run = this.runs.get(runId);

    if (!run) {
      throw new Error('in_turn_unknown_run');
    }

    run.sequence += 1;

    return run.sequence;
  }

  /**
   * Приём уточнения. Проверки идут от детерминированных к зависящим от состояния: сначала
   * формат, потом дубликат (его можно восстановить и после финала), затем живость запуска,
   * готовность канала и очередь. Устойчивая запись делается до ответа `202`.
   */
  async accept(input: InTurnAcceptInput): Promise<InTurnAcceptResult> {
    const text = String(input.text ?? '');
    const attachments = input.attachments || [];

    if (!IN_TURN_SEGMENT_RE.test(input.chatKey) || !IN_TURN_ID_RE.test(input.messageId)
      || !IN_TURN_ID_RE.test(input.runId)) {
      return reject(400, 'invalid_in_turn_message', 'Некорректный идентификатор сообщения или запуска.');
    }
    if (!text.trim() && !attachments.length) {
      return reject(400, 'invalid_in_turn_message', 'Пустой текст уточнения.');
    }
    if (utf8Bytes(text) > IN_TURN_TEXT_LIMIT_BYTES) {
      return reject(413, 'message_too_large', 'Текст уточнения длиннее 32 КиБ.');
    }
    if (attachments.length > IN_TURN_ATTACHMENT_LIMIT) {
      return reject(
        413,
        'message_too_large',
        `В одном уточнении не больше ${IN_TURN_ATTACHMENT_LIMIT} картинок.`,
      );
    }

    await this.ledger.load();

    const fingerprint = inTurnFingerprint({
      chatKey: input.chatKey,
      runId: input.runId,
      text,
      ...(input.sentAt ? { sentAt: input.sentAt } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      files: attachments.map((attachment) => attachment.file),
    });
    const known = this.ledger.get(input.chatKey, input.messageId);

    if (known) {
      if (known.fingerprint !== fingerprint || known.runId !== input.runId) {
        return reject(409, 'message_conflict', 'Этот id уже принадлежит другому сообщению.');
      }

      return { ok: true, receipt: this.receiptOf({ ...known, duplicate: true }) };
    }

    const run = this.runs.get(input.runId);

    if (!run || run.closing || run.closed || run.chatKey !== input.chatKey) {
      return reject(409, 'turn_changed', 'Ход уже завершился: сообщение не передано.');
    }
    if (attachments.length && !run.images) {
      return reject(
        409,
        'in_turn_unavailable',
        'Этот исполнитель не принимает картинки во время хода.',
        'unsupported',
      );
    }
    if (!run.availability.available) {
      return reject(
        409,
        'in_turn_unavailable',
        'Сейчас уточнение передать нельзя.',
        run.availability.reason || 'not_ready',
      );
    }
    if (this.ledger.pendingCount(input.runId) >= IN_TURN_BACKLOG_LIMIT) {
      return reject(429, 'in_turn_backlog_full', 'Слишком много непереданных уточнений этого хода.');
    }

    const sequence = this.nextSequence(input.runId);
    const record: InTurnRecord = {
      chatKey: input.chatKey,
      messageId: input.messageId,
      runId: input.runId,
      ...(run.parentTurnId ? { parentTurnId: run.parentTurnId } : {}),
      state: 'accepted',
      revision: 1,
      sequence,
      text,
      ...(attachments.length ? { attachments } : {}),
      fingerprint,
      acceptedAt: this.now(),
      updatedAt: this.now(),
      ...(Number.isSafeInteger(input.sentAt) && input.sentAt ? { sentAt: input.sentAt } : {}),
    };

    await this.ledger.put(record);
    run.revision += 1;
    this.onChange?.({
      kind: 'receipt',
      chatKey: record.chatKey,
      runId: record.runId,
      messageId: record.messageId,
      state: record.state,
    });
    this.schedule(run, record);

    return { ok: true, receipt: this.receiptOf(record) };
  }

  receipt(chatKey: string, messageId: string): InTurnReceipt | null {
    const record = this.ledger.get(chatKey, messageId);

    return record ? this.receiptOf(record) : null;
  }

  /**
   * Позднее подтверждение потребления. Приходит после ответа `deliver` или вовсе без него;
   * состояние поднимается только вперёд, revision растёт, повтор ничего не ломает.
   */
  async noteReceipt(
    event: InTurnReceiptEvent & { runId: string; chatKey: string },
  ): Promise<InTurnReceipt | null> {
    const updated = await this.ledger.update(event.chatKey, event.messageId, {
      state: event.state,
      ...(event.error ? { error: event.error } : {}),
      ...(event.state === 'consumed' ? { consumedAt: this.now() } : {}),
    });

    if (!updated) {
      return null;
    }

    const run = this.runs.get(updated.runId);

    if (run) {
      run.revision += 1;
    }

    this.onChange?.({
      kind: 'receipt',
      chatKey: updated.chatKey,
      runId: updated.runId,
      messageId: updated.messageId,
      state: updated.state,
    });

    return this.receiptOf(updated);
  }

  /**
   * Закрытие приёма: «стоп», финал хода или слив сервера. Непереданные сообщения получают
   * честный исход, подтверждённая доставка сохраняется, а сам транспорт получает close.
   */
  async closeRun(runId: string, reason = 'Ход завершился.'): Promise<void> {
    const run = this.runs.get(runId);

    if (!run || run.closed) {
      return;
    }

    run.closing = true;
    this.wake(run);

    for (const entry of this.ledger.byRun(runId)) {
      if (entry.state === 'accepted') {
        await this.ledger.update(entry.chatKey, entry.messageId, {
          state: 'failed',
          error: reason,
          failedAt: this.now(),
        });
      } else if (entry.state === 'delivering') {
        await this.ledger.update(entry.chatKey, entry.messageId, {
          state: 'unknown',
          error: 'Доставка не подтверждена: ход завершился во время передачи.',
        });
      }
    }

    run.closed = true;
    run.closing = false;
    run.port?.close?.(reason);
    run.port = null;
    this.wake(run);
  }

  /**
   * Страница записей запуска: уточнения и видимые блоки в общем порядке sequence.
   * Курсор всегда продвигается, поэтому новые записи не удлиняют текущий проход.
   */
  page(runId: string, options: {
    afterSequence?: number;
    limit?: number;
    throughSequence?: number;
    textLimit?: number;
  } = {}): InTurnPage {
    const limit = Math.max(1, Math.min(Number(options.limit) || IN_TURN_PAGE_LIMIT, IN_TURN_PAGE_LIMIT));
    const textLimit = Math.max(1024, Number(options.textLimit) || IN_TURN_PAGE_TEXT_LIMIT);
    const after = Math.max(0, Number(options.afterSequence) || 0);
    const all = this.mergedEntries(runId);
    const lastSequence = all.length ? all[all.length - 1]!.sequence : 0;
    const requestedThrough = Number.isSafeInteger(options.throughSequence) && options.throughSequence! > 0
      ? options.throughSequence!
      : lastSequence;
    const through = Math.min(requestedThrough, lastSequence);

    const entries: Array<InTurnReceipt | InTurnAssistantBlock> = [];
    let bytes = 0;
    let last = after;

    for (const entry of all) {
      if (entry.sequence <= after || entry.sequence > through) {
        continue;
      }
      if (entries.length >= limit) {
        break;
      }

      const text = 'text' in entry ? entry.text : '';
      const size = utf8Bytes(text);

      if (entries.length && bytes + size > textLimit) {
        break;
      }

      entries.push(entry);
      bytes += size;
      last = entry.sequence;
    }

    const more = all.some((entry) => entry.sequence > last && entry.sequence <= through);

    return {
      entries,
      nextAfterSequence: more ? last : null,
      throughSequence: through,
      runRevision: this.runs.get(runId)?.revision || 0,
      truncated: more,
    };
  }

  /** Ограниченная проекция для `/api/chat/active`: новые окна не тянут весь журнал. */
  activeProjection(runId: string): InTurnPage {
    return this.page(runId, {
      limit: IN_TURN_ACTIVE_LIMIT,
      textLimit: IN_TURN_ACTIVE_TEXT_LIMIT,
    });
  }

  private mergedEntries(runId: string): Array<InTurnReceipt | InTurnAssistantBlock> {
    const receipts: Array<InTurnReceipt | InTurnAssistantBlock> = this.ledger
      .byRun(runId)
      .map((entry) => this.receiptOf(entry));
    const blocks: InTurnAssistantBlock[] = this.assistant.byRun(runId);

    return [...receipts, ...blocks].sort((left, right) => left.sequence - right.sequence);
  }

  /**
   * Публичная форма записи журнала: наружу уходят только поля, нужные окну, — fingerprint,
   * служебные отметки истории и пути хранения остаются внутри координатора.
   */
  private receiptOf(record: InTurnRecord): InTurnReceipt {
    return {
      chatKey: record.chatKey,
      messageId: record.messageId,
      runId: record.runId,
      ...(record.parentTurnId ? { parentTurnId: record.parentTurnId } : {}),
      state: record.state,
      revision: record.revision,
      sequence: record.sequence,
      text: record.text,
      ...(record.attachments?.length ? { attachments: record.attachments } : {}),
      acceptedAt: record.acceptedAt,
      updatedAt: record.updatedAt,
      ...(record.sentAt ? { sentAt: record.sentAt } : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(record.duplicate ? { duplicate: true } : {}),
    };
  }

  /** Доставка идёт отдельной последовательной задачей: приём и стоп её не ждут. */
  private schedule(run: RunState, record: InTurnRecord): void {
    run.delivery = run.delivery
      .then(() => this.deliver(run, record.messageId))
      .catch(() => {});
  }

  /**
   * Один шаг передачи: дождаться безопасной границы, записать `delivering`, вызвать порт и
   * разобрать исход. Неопределённый ответ транспорта становится `unknown`, а не повтором.
   */
  private async deliver(run: RunState, messageId: string): Promise<void> {
    const before = this.ledger.get(run.chatKey, messageId);

    if (!before || !isPendingDelivery(before.state)) {
      return;
    }

    const ready = await this.waitAvailable(run);

    if (!ready) {
      await this.finishRecord(run, messageId, 'failed', CLOSED_REPLY);

      return;
    }

    const current = this.ledger.get(run.chatKey, messageId);

    if (!current || !isPendingDelivery(current.state)) {
      return;
    }

    const delivering = await this.ledger.update(run.chatKey, messageId, { state: 'delivering' });

    if (!delivering) {
      return;
    }

    // За время записи мог начаться финал или вопрос агента. Перед внешним эффектом
    // ещё раз проверяем тот же run и ждём открытия канала, если спрос уже появился.
    const stillReady = await this.waitAvailable(run);

    if (!stillReady || run.closing || run.closed
      || this.ledger.get(run.chatKey, messageId)?.state !== 'delivering') {
      return;
    }

    const port = run.port;

    if (!port) {
      await this.finishRecord(run, messageId, 'failed', 'Канал передачи недоступен.');

      return;
    }

    let result;

    try {
      result = await port.deliver({
        messageId,
        text: delivering.text,
        sequence: delivering.sequence,
        ...(delivering.attachments?.length ? { attachments: delivering.attachments } : {}),
      });
    } catch (error) {
      const reason = (error as Error)?.message || 'сбой транспорта';

      await this.finishRecord(run, messageId, 'unknown', `Доставка не подтверждена: ${reason}.`);

      return;
    }

    if (result.ok) {
      await this.finishRecord(run, messageId, result.state, '');

      return;
    }
    if (result.uncertain) {
      await this.finishRecord(run, messageId, 'unknown', result.message);

      return;
    }

    await this.finishRecord(run, messageId, 'failed', result.message || result.code);
  }

  /**
   * Записать исход передачи: состояние, причину и отметку времени. Поздний исход не
   * понижает уже подтверждённое состояние — это решает журнал своим правилом переходов.
   */
  private async finishRecord(
    run: RunState,
    messageId: string,
    state: 'forwarded' | 'consumed' | 'failed' | 'unknown',
    error: string,
  ): Promise<void> {
    const updated = await this.ledger.update(run.chatKey, messageId, {
      state,
      ...(error && state !== 'forwarded' && state !== 'consumed' ? { error } : {}),
      ...(state === 'consumed' ? { consumedAt: this.now() } : {}),
      ...(state === 'failed' ? { failedAt: this.now() } : {}),
    });

    if (!updated) {
      return;
    }

    run.revision += 1;
    this.onChange?.({
      kind: 'receipt',
      chatKey: updated.chatKey,
      runId: updated.runId,
      messageId: updated.messageId,
      state: updated.state,
    });
  }

  /**
   * Ждём открытия канала или закрытия запуска: до этого внешний вызов не делается,
   * иначе вопрос мог бы уйти агенту как ответ на ожидающее разрешение.
   */
  private waitAvailable(run: RunState): Promise<boolean> {
    if (run.closed || run.closing) {
      return Promise.resolve(false);
    }
    if (run.availability.available && run.port) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      run.waiters.push(() => {
        resolve(!run.closed && !run.closing && run.availability.available && !!run.port);
      });
    });
  }

  private wake(run: RunState): void {
    const waiters = run.waiters.splice(0);

    for (const waiter of waiters) {
      waiter();
    }
  }
}

function reject(
  status: number,
  code: string,
  message: string,
  reason?: InTurnUnavailableReason,
): InTurnAcceptResult {
  return {
    ok: false,
    status,
    code,
    message,
    ...(reason ? { reason } : {}),
  };
}
