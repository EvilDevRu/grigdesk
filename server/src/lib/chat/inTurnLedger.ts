// Durable журнал уточнений внутри активного хода.
//
// Запись на пару (chatKey, messageId): приём, исходный текст, состояние доставки, revision и
// общий sequence запуска. Журнал — источник истины о приёме: окно, транспорт и восстановление
// после падения читают его, а не память процесса. Файл на уточнение, tmp+rename, очередь
// записей одного id — как у журнала ходов.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  IN_TURN_ID_RE,
  IN_TURN_RETENTION_MS,
  IN_TURN_SEGMENT_RE,
  canTransition,
  isPendingDelivery,
} from '../../../../shared/chat/chatInTurnContracts.ts';
import type { InTurnDeliveryState, InTurnReceipt } from '../../../../shared/chat/chatInTurnContracts.ts';

export interface InTurnRecord extends InTurnReceipt {
  fingerprint: string;
  consumedAt?: number;
  failedAt?: number;
  savedToHistoryAt?: number;
}

const STATES = new Set<string>([
  'accepted',
  'delivering',
  'forwarded',
  'consumed',
  'failed',
  'unknown',
]);

const PRUNE_EVERY_PUTS = 200;

/**
 * Запись с диска проверяется целиком: битый или чужой файл не становится уточнением,
 * а значит, не может ни заблокировать повтор, ни получить доставку после рестарта.
 */
function isInTurnRecord(value: unknown): value is InTurnRecord {
  const entry = value as Partial<InTurnRecord> | null;

  return !!entry
    && typeof entry.chatKey === 'string'
    && IN_TURN_SEGMENT_RE.test(entry.chatKey)
    && typeof entry.messageId === 'string'
    && IN_TURN_ID_RE.test(entry.messageId)
    && typeof entry.runId === 'string'
    && IN_TURN_ID_RE.test(entry.runId)
    && STATES.has(String(entry.state))
    && typeof entry.text === 'string'
    && (entry.attachments === undefined || Array.isArray(entry.attachments))
    && Number.isSafeInteger(entry.revision)
    && Number.isSafeInteger(entry.sequence)
    && Number.isSafeInteger(entry.acceptedAt);
}

export class ChatInTurnLedger {
  readonly dir: string;

  private readonly now: () => number;

  private readonly retentionMs: number;

  private readonly entries = new Map<string, InTurnRecord>();

  private readonly writes = new Map<string, Promise<void>>();

  private loading: Promise<void> | null = null;

  private putsSincePrune = 0;

  constructor({
    dir,
    now = () => Date.now(),
    retentionMs = IN_TURN_RETENTION_MS,
  }: {
    dir: string;
    now?: () => number;
    retentionMs?: number;
  }) {
    this.dir = dir;
    this.now = now;
    this.retentionMs = retentionMs;
  }

  /** Читает каталог один раз за процесс: дальше журнал живёт в памяти и на диске. */
  load(): Promise<void> {
    this.loading ||= this.readAll();

    return this.loading;
  }

  get(chatKey: string, messageId: string): InTurnRecord | null {
    return this.entries.get(this.keyOf(chatKey, messageId)) || null;
  }

  /** Все уточнения запуска в порядке появления; sequence назначается один раз и не меняется. */
  byRun(runId: string): InTurnRecord[] {
    return [...this.entries.values()]
      .filter((entry) => entry.runId === runId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  /**
   * Идентификаторы запусков чата в порядке первого появления: по ним строится проекция
   * разговора для следующего хода, когда окно уже закрыто.
   */
  byChat(chatKey: string): string[] {
    const first = new Map<string, number>();

    for (const entry of this.entries.values()) {
      if (entry.chatKey !== chatKey) {
        continue;
      }

      const at = first.get(entry.runId);

      if (at === undefined || entry.acceptedAt < at) {
        first.set(entry.runId, entry.acceptedAt);
      }
    }

    return [...first.entries()].sort((left, right) => left[1] - right[1]).map(([runId]) => runId);
  }

  /** Сколько сообщений запуска ещё не получили исхода: ими ограничен backlog. */
  pendingCount(runId: string): number {
    return this.byRun(runId).filter((entry) => isPendingDelivery(entry.state)).length;
  }

  /**
   * Новая запись приёма. В память попадает сразу: повтор, пришедший до конца записи на
   * диск, уже видит сообщение принятым, а не создаёт вторую доставку.
   */
  async put(record: InTurnRecord): Promise<InTurnRecord> {
    this.assertSegments(record.chatKey, record.messageId);

    const stored: InTurnRecord = { ...record };
    const key = this.keyOf(stored.chatKey, stored.messageId);

    this.entries.set(key, stored);
    await this.persist(key);
    this.putsSincePrune += 1;

    if (this.putsSincePrune >= PRUNE_EVERY_PUTS) {
      this.putsSincePrune = 0;
      void this.prune().catch(() => {});
    }

    return stored;
  }

  /**
   * Смена состояния с ростом revision. Владелец записи (чат, id, текст, run) патчем не
   * меняется; запрещённый переход (например, consumed → forwarded) не применяется вовсе,
   * поэтому поздний ACK не откатывает уже подтверждённое потребление.
   */
  async update(
    chatKey: string,
    messageId: string,
    patch: Partial<InTurnRecord> & { state: InTurnDeliveryState },
  ): Promise<InTurnRecord | null> {
    const key = this.keyOf(chatKey, messageId);
    const current = this.entries.get(key);

    if (!current) {
      return null;
    }
    if (!canTransition(current.state, patch.state)) {
      return current;
    }

    const next: InTurnRecord = {
      ...current,
      ...patch,
      chatKey: current.chatKey,
      messageId: current.messageId,
      runId: current.runId,
      text: current.text,
      sequence: current.sequence,
      acceptedAt: current.acceptedAt,
      revision: current.revision + 1,
      updatedAt: this.now(),
    };

    this.entries.set(key, next);
    await this.persist(key);

    return next;
  }

  /**
   * Отметка «текст перенесён в историю»: с этого момента запись можно убирать по сроку
   * хранения, а не держать вечно. Неизвестный id — не ошибка: уборка могла её снять.
   */
  async markSavedToHistory(chatKey: string, messageId: string): Promise<void> {
    await this.update(chatKey, messageId, {
      state: this.get(chatKey, messageId)?.state || 'accepted',
      savedToHistoryAt: this.now(),
    });
  }

  /**
   * Восстановление после падения: незавершённые попытки мёртвого запуска получают честный
   * исход. `accepted` не был передан — `failed/server_restarted`; `delivering` мог дойти до
   * транспорта — `unknown`. Агент при этом не запускается.
   */
  async sweepDeadRuns(activeRunIds: ReadonlySet<string>): Promise<InTurnRecord[]> {
    await this.load();

    const touched: InTurnRecord[] = [];

    for (const entry of [...this.entries.values()]) {
      if (activeRunIds.has(entry.runId) || !isPendingDelivery(entry.state)) {
        continue;
      }

      const state: InTurnDeliveryState = entry.state === 'delivering' ? 'unknown' : 'failed';
      const error = entry.state === 'delivering'
        ? 'Доставка не подтверждена: сервер перезапустился во время передачи.'
        : 'Сообщение не передано: сервер перезапустился.';
      const updated = await this.update(entry.chatKey, entry.messageId, {
        state,
        error,
        ...(state === 'failed' ? { failedAt: this.now() } : {}),
      });

      if (updated) {
        touched.push(updated);
      }
    }

    return touched;
  }

  /**
   * Уборка по сроку хранения. Трогаем только завершённые исходы, чей текст уже перенесён
   * в историю: недоставленное и неопределённое не удаляется, иначе человек потеряет
   * единственную копию своего вопроса.
   */
  async prune(): Promise<void> {
    const cutoff = this.now() - this.retentionMs;

    for (const [key, entry] of [...this.entries]) {
      const finished = !isPendingDelivery(entry.state);
      const old = (entry.updatedAt || entry.acceptedAt) < cutoff;

      if (!finished || !old || !entry.savedToHistoryAt) {
        continue;
      }

      this.entries.delete(key);
      await this.chain(key, () => this.removeFile(entry.chatKey, entry.messageId));
    }
  }

  private keyOf(chatKey: string, messageId: string): string {
    return `${chatKey}\u0000${messageId}`;
  }

  /** Сегменты пути проверяются до создания файла: «..» и разделители сюда не попадают. */
  private assertSegments(chatKey: string, messageId: string): void {
    if (!IN_TURN_SEGMENT_RE.test(chatKey) || !IN_TURN_ID_RE.test(messageId)) {
      throw new Error('in_turn_bad_storage_segment');
    }
  }

  private fileOf(chatKey: string, messageId: string): string {
    return path.join(this.dir, chatKey, `${messageId}.json`);
  }

  /**
   * Убрать файл записи и пустой каталог чата. Отсутствие файла — не ошибка: уборка
   * повторяется, а запись могла быть удалена предыдущим проходом.
   */
  private async removeFile(chatKey: string, messageId: string): Promise<void> {
    await fs.rm(this.fileOf(chatKey, messageId), { force: true });

    const parent = path.join(this.dir, chatKey);

    try {
      const rest = await fs.readdir(parent);

      if (!rest.length) {
        await fs.rmdir(parent);
      }
    } catch {
      // Каталог уже убран или недоступен — уборке это не мешает.
    }
  }

  /**
   * Записи одного уточнения идут по очереди, и каждая пишет ТЕКУЩЕЕ состояние из памяти:
   * поздняя запись `delivering` не может лечь поверх уже записанного `consumed`.
   */
  private persist(key: string): Promise<void> {
    return this.chain(key, async () => {
      const entry = this.entries.get(key);

      if (!entry) {
        return;
      }

      const file = this.fileOf(entry.chatKey, entry.messageId);

      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(entry));
      await fs.rename(`${file}.tmp`, file);
    });
  }

  /**
   * Очередь операций с файлом одного уточнения: следующая ждёт предыдущую, даже упавшую.
   * Хвост снимается, когда за время работы его никто не продлил, — карта не растёт.
   */
  private chain(key: string, job: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(key) || Promise.resolve();
    const next = previous.then(job, job);
    const tail = next.then(() => {}, () => {});

    this.writes.set(key, tail);
    void tail.then(() => {
      if (this.writes.get(key) === tail) {
        this.writes.delete(key);
      }
    });

    return next;
  }

  /**
   * Полное чтение каталога: битые файлы пропускаются, просроченные завершённые записи
   * удаляются сразу, а всё остальное поднимается в память как состояние до падения.
   */
  private async readAll(): Promise<void> {
    let chats: string[] = [];

    try {
      chats = await fs.readdir(this.dir);
    } catch {
      return;
    }

    const cutoff = this.now() - this.retentionMs;

    for (const chatKey of chats) {
      if (!IN_TURN_SEGMENT_RE.test(chatKey)) {
        continue;
      }

      const chatDir = path.join(this.dir, chatKey);
      let files: string[] = [];

      try {
        files = await fs.readdir(chatDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }

        const full = path.join(chatDir, file);
        let entry: unknown = null;

        try {
          entry = JSON.parse(await fs.readFile(full, 'utf8'));
        } catch {
          continue;
        }

        if (!isInTurnRecord(entry) || entry.chatKey !== chatKey) {
          continue;
        }

        const finished = !isPendingDelivery(entry.state);
        const old = (entry.updatedAt || entry.acceptedAt) < cutoff;

        if (finished && old && entry.savedToHistoryAt) {
          await fs.rm(full, { force: true }).catch(() => {});
          continue;
        }

        this.entries.set(this.keyOf(entry.chatKey, entry.messageId), entry);
      }
    }
  }
}
