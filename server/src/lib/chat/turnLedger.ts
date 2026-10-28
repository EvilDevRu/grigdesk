// Журнал принятых ходов чата.
//
// Окно присылает устойчивый turnId, сервер коротко подтверждает приём, а сам ход идёт
// дальше без HTTP-соединения. Журнал отвечает на три вопроса, на которые раньше
// ответа не было: принимался ли уже этот turnId (повтор после потерянного ответа не
// запускает исполнителя второй раз), в каком он состоянии (окно после F5 отличает
// «не дошло» от «идёт») и какие ходы прошлый процесс не довёл до итога (после падения
// они получают честную ошибку вместо тишины). Файл на ход — те же tmp+rename, что у
// истории и pending: оборванная запись не оставляет полуфайла.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ResolvedWorkdir } from './workdir.ts';
import { writeDurableFile } from '../durableFile.ts';
import type { ChatModeSelection } from '../../../../shared/chat/chatPermissionModes.ts';

export type MobileTurnOwner = {
  deviceId: string;
  clientId: string;
  contentHash: string;
};

export type TurnState = 'queued' | 'running' | 'done';

export interface TurnEntry {
  turnId: string;
  chatKey: string;
  state: TurnState;
  acceptedAt: number;
  startedAt?: number;
  finishedAt?: number;
  // Чем кончился ход: reply, stopped, error, refused или interrupted.
  outcome?: string;
  // Вопрос человека: итог после падения сервера обязан нести его, как обычный pending.
  userText?: string;
  userSentAt?: number;
  hadAttachments?: boolean;
  workspace?: ResolvedWorkdir;
  permissionMode?: string;
  modeSelection?: ChatModeSelection;
  // Назначает только серверный порт mobileChat; HTTP-тело не переносит это поле.
  mobileOwner?: MobileTurnOwner;
  runId?: string;
  mobileHistoryEpoch?: number;
  historySuppressed?: boolean;
}

export const TURN_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

// Сколько помнить законченный ход. Повтор после потерянного подтверждения приходит
// за секунды или минуты; неделя закрывает и уснувший ноутбук с открытой вкладкой.
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Уборка по ходу работы, чтобы долгий аптайм не копил память без рестарта.
const PRUNE_EVERY_PUTS = 200;
const TURN_STATES = new Set<string>(['queued', 'running', 'done']);

/**
 * Запись с диска проверяется целиком: чужой или битый файл не становится ходом, а
 * значит, не может ни заблокировать повтор, ни получить итог после рестарта.
 */
function isTurnEntry(value: unknown): value is TurnEntry {
  const entry = value as Partial<TurnEntry> | null;

  return !!entry
    && typeof entry.turnId === 'string'
    && TURN_ID_RE.test(entry.turnId)
    && typeof entry.chatKey === 'string'
    && !!entry.chatKey
    && TURN_STATES.has(String(entry.state))
    && Number.isSafeInteger(entry.acceptedAt);
}

export class ChatTurnLedger {
  readonly dir: string;

  private readonly now: () => number;

  private readonly retentionMs: number;

  private readonly entries = new Map<string, TurnEntry>();

  private readonly writes = new Map<string, Promise<void>>();

  private loading: Promise<TurnEntry[]> | null = null;

  private putsSincePrune = 0;

  constructor({
    dir,
    now = () => Date.now(),
    retentionMs = DEFAULT_RETENTION_MS,
  }: {
    dir: string;
    now?: () => number;
    retentionMs?: number;
  }) {
    this.dir = dir;
    this.now = now;
    this.retentionMs = retentionMs;
  }

  /**
   * Читает журнал один раз за процесс. Возвращает ходы, которые прошлый процесс
   * принял, но не довёл до итога: вызывающий обязан выдать по ним ошибку окну.
   */
  load(): Promise<TurnEntry[]> {
    this.loading ||= this.readAll();

    return this.loading;
  }

  get(turnId: string): TurnEntry | null {
    return this.entries.get(turnId) || null;
  }

  /**
   * Принятые мобильные ходы нужны сверке истории после падения и перед чтением.
   * Возвращает копии метаданных, не создавая вторую очередь исполнения.
   */
  mobileTurns(chatKey?: string): TurnEntry[] {
    return [...this.entries.values()].filter((entry) => entry.mobileOwner
      && (!chatKey || entry.chatKey === chatKey)).map((entry) => ({ ...entry }));
  }

  /** Принятые, но ещё не начатые ходы в порядке приёма; по чату или все. */
  queued(chatKey = ''): TurnEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.state === 'queued' && (!chatKey || entry.chatKey === chatKey))
      .sort((left, right) => left.acceptedAt - right.acceptedAt);
  }

  /**
   * Новая запись. В память попадает сразу: повтор, пришедший до конца записи на диск,
   * уже видит ход принятым.
   */
  async put(entry: TurnEntry): Promise<TurnEntry> {
    const stored = { ...entry };

    this.entries.set(stored.turnId, stored);

    try {
      await this.persist(stored.turnId);
    } catch (error) {
      if (this.entries.get(stored.turnId) === stored) {
        this.entries.delete(stored.turnId);
      }

      throw error;
    }

    this.putsSincePrune += 1;

    if (this.putsSincePrune >= PRUNE_EVERY_PUTS) {
      this.putsSincePrune = 0;
      void this.prune().catch(() => {});
    }

    return stored;
  }

  /**
   * Сменить состояние хода в памяти и записать его на диск. Неизвестный turnId — не
   * ошибка: законченную запись могла убрать уборка, и поздняя отметка ей не нужна.
   * Владелец записи (turnId и чат) патчем не меняется.
   */
  async update(turnId: string, patch: Partial<TurnEntry>): Promise<TurnEntry | null> {
    const current = this.entries.get(turnId);

    if (!current) {
      return null;
    }

    Object.assign(current, patch, { turnId: current.turnId, chatKey: current.chatKey });
    await this.persist(turnId);

    return current;
  }

  /**
   * Убрать законченные ходы старше срока хранения — из памяти и с диска. Незаконченные
   * не трогаются никогда: по ним окно ещё ждёт итога, а старт процесса выдаёт его сам.
   */
  async prune(): Promise<void> {
    const cutoff = this.now() - this.retentionMs;

    for (const [turnId, entry] of [...this.entries]) {
      if (entry.state !== 'done' || (entry.finishedAt || entry.acceptedAt) >= cutoff) {
        continue;
      }

      this.entries.delete(turnId);
      await this.chain(turnId, () => fs.rm(this.fileOf(turnId), { force: true }));
    }
  }

  private fileOf(turnId: string): string {
    return path.join(this.dir, `${turnId}.json`);
  }

  /**
   * Записи одного хода идут по очереди, и каждая пишет ТЕКУЩЕЕ состояние из памяти:
   * поздняя запись «running» не может лечь поверх уже записанного «done».
   */
  private persist(turnId: string): Promise<void> {
    return this.chain(turnId, async () => {
      const entry = this.entries.get(turnId);

      if (!entry) {
        return;
      }

      const file = this.fileOf(turnId);

      if (entry.mobileOwner) {
        await writeDurableFile(file, JSON.stringify(entry));

        return;
      }

      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(entry));
      await fs.rename(`${file}.tmp`, file);
    });
  }

  /**
   * Очередь операций с файлом одного хода: следующая ждёт предыдущую, даже упавшую.
   * Хвост снимается, когда за время работы его никто не продлил, — карта не растёт.
   */
  private chain(turnId: string, job: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(turnId) || Promise.resolve();
    const next = previous.then(job, job);
    const tail = next.then(() => {}, () => {});

    this.writes.set(turnId, tail);
    void tail.then(() => {
      if (this.writes.get(turnId) === tail) {
        this.writes.delete(turnId);
      }
    });

    return next;
  }

  /**
   * Полное чтение каталога при первом обращении. Просроченные законченные ходы
   * удаляются сразу, незаконченные возвращаются вызывающему как наследство падения.
   */
  private async readAll(): Promise<TurnEntry[]> {
    let files: string[] = [];

    try {
      files = await fs.readdir(this.dir);
    } catch {
      return [];
    }

    const cutoff = this.now() - this.retentionMs;
    const unfinished: TurnEntry[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      const full = path.join(this.dir, file);
      let entry: unknown = null;

      try {
        entry = JSON.parse(await fs.readFile(full, 'utf8'));
      } catch {
        continue;
      }

      if (!isTurnEntry(entry)) {
        continue;
      }
      if (entry.state === 'done' && (entry.finishedAt || entry.acceptedAt) < cutoff) {
        await fs.rm(full, { force: true }).catch(() => {});
        continue;
      }

      this.entries.set(entry.turnId, entry);

      if (entry.state !== 'done') {
        unfinished.push({ ...entry });
      }
    }

    return unfinished.sort((left, right) => left.acceptedAt - right.acceptedAt);
  }
}
