// Durable журнал видимых ответов агента внутри запуска.
//
// Каждый законченный текстовый блок лежит отдельным файлом: он переживает F5, второе окно и
// падение сервера, а окно собирает ответ страницами, не зная заранее списка id. Потоковые
// дельты живут в памяти и попадают на диск только при завершении блока — иначе каждый токен
// превращался бы в запись файла.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  IN_TURN_BLOCK_TEXT_LIMIT,
  IN_TURN_ID_RE,
  IN_TURN_RETENTION_MS,
  IN_TURN_SEGMENT_RE,
  cutInTurnText,
} from '../../../../shared/chat/chatInTurnContracts.ts';
import type { InTurnAssistantBlock } from '../../../../shared/chat/chatInTurnContracts.ts';

export interface AssistantBlockRecord extends InTurnAssistantBlock {
  savedToHistoryAt?: number;
}

/**
 * Запись с диска проверяется целиком: битый файл не становится ответом и не может
 * подменить уже показанный блок при восстановлении.
 */
function isAssistantBlock(value: unknown): value is AssistantBlockRecord {
  const entry = value as Partial<AssistantBlockRecord> | null;

  return !!entry
    && typeof entry.runId === 'string'
    && IN_TURN_ID_RE.test(entry.runId)
    && typeof entry.chatKey === 'string'
    && IN_TURN_SEGMENT_RE.test(entry.chatKey)
    && typeof entry.assistantMessageId === 'string'
    && IN_TURN_ID_RE.test(entry.assistantMessageId)
    && Number.isSafeInteger(entry.sequence)
    && Number.isSafeInteger(entry.revision)
    && typeof entry.text === 'string'
    && typeof entry.complete === 'boolean'
    && (entry.abandoned === undefined || typeof entry.abandoned === 'boolean')
    && Number.isSafeInteger(entry.startedAt);
}

/** Блок больше не нужен окну и истории: перенесён в историю или брошен транспортом. */
function isSettledBlock(block: AssistantBlockRecord): boolean {
  return block.abandoned === true || (block.complete && !!block.savedToHistoryAt);
}

export class ChatAssistantMessages {
  readonly dir: string;

  private readonly now: () => number;

  private readonly retentionMs: number;

  private readonly blocks = new Map<string, AssistantBlockRecord>();

  private readonly drafts = new Map<string, string>();

  private readonly writes = new Map<string, Promise<void>>();

  private loading: Promise<void> | null = null;

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

  load(): Promise<void> {
    this.loading ||= this.readAll();

    return this.loading;
  }

  get(runId: string, assistantMessageId: string): AssistantBlockRecord | null {
    return this.blocks.get(this.keyOf(runId, assistantMessageId)) || null;
  }

  /** Блоки запуска по sequence: так окно восстанавливает чередование с уточнениями. */
  byRun(runId: string): AssistantBlockRecord[] {
    return [...this.blocks.values()]
      .filter((block) => block.runId === runId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  /** Незавершённые блоки: их текст ещё копится в памяти и честно помечается `complete: false`. */
  live(runId: string): AssistantBlockRecord[] {
    return this.byRun(runId)
      .filter((block) => !block.complete && !block.abandoned)
      .map((block) => ({
        ...block,
        text: this.drafts.get(this.keyOf(runId, block.assistantMessageId)) || block.text,
      }));
  }

  /**
   * Начало видимого блока. Дубликат того же id не создаёт вторую запись: адаптер может
   * объявить блок и до, и после первого текста, а идентичность обязана остаться одной.
   */
  async begin(input: {
    runId: string;
    chatKey: string;
    assistantMessageId: string;
    sequence: number;
  }): Promise<AssistantBlockRecord> {
    this.assertSegments(input.runId, input.assistantMessageId);

    const key = this.keyOf(input.runId, input.assistantMessageId);
    const existing = this.blocks.get(key);

    if (existing) {
      return existing;
    }

    const record: AssistantBlockRecord = {
      runId: input.runId,
      chatKey: input.chatKey,
      assistantMessageId: input.assistantMessageId,
      sequence: input.sequence,
      revision: 1,
      text: '',
      complete: false,
      startedAt: this.now(),
    };

    this.blocks.set(key, record);
    this.drafts.set(key, '');
    await this.persist(key);

    return record;
  }

  /**
   * Накопление дельты в памяти. Возвращает текущий текст блока, чтобы адаптер мог
   * показать его живо, не дожидаясь завершения и не трогая диск на каждый токен.
   */
  appendDelta(runId: string, assistantMessageId: string, delta: string): string {
    const key = this.keyOf(runId, assistantMessageId);
    const block = this.blocks.get(key);

    if (!block || block.complete || block.abandoned) {
      return block?.text || '';
    }

    const next = `${this.drafts.get(key) || ''}${String(delta ?? '')}`;

    this.drafts.set(key, next);

    return next;
  }

  /**
   * Замена накопленного текста блока: адаптер присылает уже собранный текст, а не дельту.
   * На диск это не пишется — durable становится только завершённый блок.
   */
  setDraft(runId: string, assistantMessageId: string, text: string): void {
    const key = this.keyOf(runId, assistantMessageId);
    const block = this.blocks.get(key);

    if (!block || block.complete || block.abandoned) {
      return;
    }

    this.drafts.set(key, String(text ?? ''));
  }

  /**
   * Завершение блока: текст обрезается по пределу с видимой меткой, запись становится
   * durable до публикации события завершения. Итоговый текст можно передать явно —
   * тогда очистка служебных маркеров не теряет идентичность блока.
   */
  async complete(
    runId: string,
    assistantMessageId: string,
    options: { text?: string } = {},
  ): Promise<AssistantBlockRecord | null> {
    const key = this.keyOf(runId, assistantMessageId);
    const block = this.blocks.get(key);

    if (!block || block.complete) {
      return block || null;
    }

    const source = options.text !== undefined ? String(options.text) : (this.drafts.get(key) || '');
    const cut = cutInTurnText(source, IN_TURN_BLOCK_TEXT_LIMIT);
    // Поздно завершённый брошенный черновик становится обычным полным блоком.
    const { abandoned: _abandoned, ...open } = block;
    const next: AssistantBlockRecord = {
      ...open,
      text: cut.text,
      ...(cut.truncated ? { truncated: true } : {}),
      complete: true,
      revision: block.revision + 1,
      completedAt: this.now(),
    };

    this.blocks.set(key, next);
    this.drafts.delete(key);
    await this.persist(key);

    return next;
  }

  /**
   * Снять незавершённый блок при обрыве или закрытии запуска: накопленный текст сохраняется
   * и остаётся видимым, но полным блок не объявляется — после обрыва это было бы неправдой.
   * Отметка `abandoned` говорит окну, что текст больше не пишется. Текст можно передать явно.
   */
  async abandon(
    runId: string,
    assistantMessageId: string,
    options: { text?: string } = {},
  ): Promise<AssistantBlockRecord | null> {
    const key = this.keyOf(runId, assistantMessageId);
    const block = this.blocks.get(key);

    if (!block || block.complete || block.abandoned) {
      return block || null;
    }

    const source = options.text !== undefined ? String(options.text) : (this.drafts.get(key) || '');
    const next: AssistantBlockRecord = {
      ...block,
      text: cutInTurnText(source).text,
      revision: block.revision + 1,
      completedAt: this.now(),
      abandoned: true,
    };

    this.blocks.set(key, next);
    this.drafts.delete(key);
    await this.persist(key);

    return next;
  }

  /**
   * Текст перенесён в историю: только после этой отметки завершённый блок можно убирать
   * по сроку хранения, иначе уборка съела бы единственную копию ответа.
   */
  async markSavedToHistory(runId: string, assistantMessageId: string): Promise<void> {
    const key = this.keyOf(runId, assistantMessageId);
    const block = this.blocks.get(key);

    if (!block) {
      return;
    }

    this.blocks.set(key, { ...block, savedToHistoryAt: this.now() });
    await this.persist(key);
  }

  /**
   * Уборка завершённых блоков старше срока. Незавершённые и не перенесённые в историю
   * не трогаются: после падения сервера они — единственная копия ответа. Брошенный блок
   * в историю не переносится никогда, поэтому уходит по одному сроку.
   */
  async prune(): Promise<void> {
    const cutoff = this.now() - this.retentionMs;

    for (const [key, block] of [...this.blocks]) {
      const old = (block.completedAt || block.startedAt) < cutoff;

      if (!old || !isSettledBlock(block)) {
        continue;
      }

      this.blocks.delete(key);
      this.drafts.delete(key);
      await this.chain(key, () => this.removeFile(block.runId, block.assistantMessageId));
    }
  }

  /**
   * Восстановление после падения: незавершённые блоки мёртвых запусков уже никто не допишет.
   * Текст берётся с диска — черновик в памяти погиб вместе с прошлым процессом. Блок не
   * объявляется полным, а отметка обрыва даёт ему общий срок хранения. Повтор ничего не меняет.
   */
  async sweepDeadRuns(activeRunIds: ReadonlySet<string>): Promise<AssistantBlockRecord[]> {
    await this.load();

    const touched: AssistantBlockRecord[] = [];

    for (const block of [...this.blocks.values()]) {
      if (activeRunIds.has(block.runId) || block.complete || block.abandoned) {
        continue;
      }

      const abandoned = await this.abandon(block.runId, block.assistantMessageId, { text: block.text });

      if (abandoned) {
        touched.push(abandoned);
      }
    }

    return touched;
  }

  private keyOf(runId: string, assistantMessageId: string): string {
    return `${runId}\u0000${assistantMessageId}`;
  }

  private assertSegments(runId: string, assistantMessageId: string): void {
    if (!IN_TURN_ID_RE.test(runId) || !IN_TURN_ID_RE.test(assistantMessageId)) {
      throw new Error('in_turn_bad_storage_segment');
    }
  }

  private fileOf(runId: string, assistantMessageId: string): string {
    return path.join(this.dir, runId, `${assistantMessageId}.json`);
  }

  /**
   * Убрать файл блока и опустевший каталог запуска. Отсутствие файла не считается
   * ошибкой: повторная уборка должна проходить молча.
   */
  private async removeFile(runId: string, assistantMessageId: string): Promise<void> {
    await fs.rm(this.fileOf(runId, assistantMessageId), { force: true });

    const parent = path.join(this.dir, runId);

    try {
      const rest = await fs.readdir(parent);

      if (!rest.length) {
        await fs.rmdir(parent);
      }
    } catch {
      // Каталог уже убран — уборке это не мешает.
    }
  }

  private persist(key: string): Promise<void> {
    return this.chain(key, async () => {
      const block = this.blocks.get(key);

      if (!block) {
        return;
      }

      const file = this.fileOf(block.runId, block.assistantMessageId);

      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(block));
      await fs.rename(`${file}.tmp`, file);
    });
  }

  /**
   * Очередь операций с файлом одного блока: следующая ждёт предыдущую, даже упавшую,
   * поэтому поздняя запись не может лечь поверх более новой. Хвост снимается сам.
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
   * Полное чтение каталога: битые файлы пропускаются, просроченные перенесённые блоки
   * удаляются, остальное поднимается в память — незавершённый текст после падения
   * остаётся честно неполным.
   */
  private async readAll(): Promise<void> {
    let runs: string[] = [];

    try {
      runs = await fs.readdir(this.dir);
    } catch {
      return;
    }

    const cutoff = this.now() - this.retentionMs;

    for (const runId of runs) {
      if (!IN_TURN_SEGMENT_RE.test(runId)) {
        continue;
      }

      const runDir = path.join(this.dir, runId);
      let files: string[] = [];

      try {
        files = await fs.readdir(runDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }

        const full = path.join(runDir, file);
        let entry: unknown = null;

        try {
          entry = JSON.parse(await fs.readFile(full, 'utf8'));
        } catch {
          continue;
        }

        if (!isAssistantBlock(entry) || entry.runId !== runId) {
          continue;
        }

        const old = (entry.completedAt || entry.startedAt) < cutoff;

        if (old && isSettledBlock(entry)) {
          await fs.rm(full, { force: true }).catch(() => {});
          continue;
        }

        this.blocks.set(this.keyOf(entry.runId, entry.assistantMessageId), entry);
      }
    }
  }
}
