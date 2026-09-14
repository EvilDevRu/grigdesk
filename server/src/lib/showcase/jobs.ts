// Журнал и очередь заданий раздела.
//
// Долгие шаги — синтез, запись браузера, сборка — исполняет отдельный процесс,
// который обязан пережить перезапуск кокпита. Отсюда три правила:
//  • ЕДИНСТВЕННЫЙ писатель журнала — сервер. Worker пишет свой отчёт о попытке,
//    а актуальные ссылки публикует сервер, сверив хеши входов;
//  • живость процесса проверяется по снимку identity (время старта и командная
//    строка), а не по одному pid: номер переиспользуется, и после перезагрузки
//    посторонний процесс оставил бы мёртвое задание вечно идущим;
//  • до сверки журнала с процессами новое задание не стартует. Иначе второй
//    browser worker пойдёт на ту же цель и испортит запись первому.
//
// Терминальное состояние обратно в работу не возвращается: «Продолжить» создаёт
// новую попытку с повторной проверкой входов.
import { promises as fs } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { processAlive } from './processIdentity.ts';
import type { ShowcaseJob, ShowcaseJobState } from '../../../../shared/showcaseContracts.ts';
import { notFound, ShowcaseError } from './errors.ts';
import type { ProcessIdentity } from './processIdentity.ts';

// Снимок процесса задания. Тип общий с установкой голоса: правило живости у них
// одно, и своё понимание identity каждому из них не нужно.
export type JobIdentity = ProcessIdentity;

export interface JobRecord {
  id: string;
  projectId: string;
  kind: ShowcaseJob['kind'];
  state: ShowcaseJobState;
  attempt: number;
  sequence: number;
  progress: { index: number; total: number; label: string };
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  // Ключ повтора: одни и те же входы дают одно задание. Двойной клик по «Собрать»
  // не запускает второй конфликтующий прогон.
  idempotencyKey: string;
  // BuildRun помечает дочернее задание устойчивым ключом ДО запуска операции.
  // Массив нужен, когда координатор присоединился к уже идущему ручному job.
  stageKeys?: string[];
  inputHashes: Record<string, string>;
  inputRevision: number;
  deadlineAt: string;
  heartbeatAt: string | null;
  identity: JobIdentity;
}

export interface ShowcaseJobsOptions {
  jobsDir: string;
  broadcast: (event: string, data: unknown) => void;
  // Пределы задаются настройками: длинный ролик не должен упереться в число,
  // зашитое в код, а очередь — расти без границы.
  limits: () => { maxQueued: number; jobTimeoutMs: number };
}

const TERMINAL: ShowcaseJobState[] = [
  'awaiting_review',
  'succeeded',
  'failed',
  'interrupted',
  'cancelled',
];
const JOB_FILE = /^[a-f0-9]{16}$/;
// Пропавший heartbeat дольше этого срока означает, что worker не отчитывается,
// даже если его процесс формально ещё существует.
//
// Срок с запасом над самым долгим законным молчанием: сцена пишется до предела
// `maxSceneSeconds` (сейчас 120 с) плюс запуск браузера, и всё это время отчитаться
// исполнителю нечем. Прежние 90 с были короче этого молчания — под нагрузкой сервер
// объявлял оборванным живого исполнителя, а запись при этом продолжалась.
// Смерть процесса ловится не отсюда, а по снимку identity, и сразу.
const HEARTBEAT_GRACE_MS = 360_000;

export function newJobId(): string {
  return randomBytes(8).toString('hex');
}

export function isTerminal(state: ShowcaseJobState): boolean {
  return TERMINAL.includes(state);
}

/**
 * Публичная проекция задания: identity процесса, ключ повтора, хеши входов и
 * сроки остаются на сервере. Наружу уходит то, что показывает строка прогресса.
 */
export function toPublicJob(record: JobRecord): ShowcaseJob {
  return {
    id: record.id,
    projectId: record.projectId,
    kind: record.kind,
    state: record.state,
    attempt: record.attempt,
    sequence: record.sequence,
    progress: record.progress,
    error: record.error,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}

export function createShowcaseJobs(options: ShowcaseJobsOptions) {
  const { jobsDir, broadcast } = options;

  // Журнал держится и в памяти: список заданий читают каждый обзор раздела, и
  // перечитывать каталог на каждое обращение дорого. Файл остаётся источником
  // правды для перезапуска, память — его отражением.
  const records = new Map<string, JobRecord>();
  const stageContext = new AsyncLocalStorage<string>();
  let recovered = false;

  function fileOf(id: string): string {
    return path.join(jobsDir, id, 'job.json');
  }

  async function persist(record: JobRecord): Promise<void> {
    const file = fileOf(record.id);

    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });

    const temporary = `${file}.tmp`;

    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, file);
    records.set(record.id, record);
  }

  /**
   * Живость задания. К общей проверке процесса добавляется своё условие: worker
   * обязан отчитываться. Молчащий дольше отведённого срока считается мёртвым,
   * даже если его процесс формально ещё существует.
   */
  function alive(record: JobRecord): boolean {
    if (!processAlive(record.identity)) {
      return false;
    }

    const beat = record.heartbeatAt ? Date.parse(record.heartbeatAt) : 0;

    return Date.now() - beat < HEARTBEAT_GRACE_MS;
  }

  function publish(record: JobRecord): void {
    broadcast('showcase-progress', {
      jobId: record.id,
      projectId: record.projectId,
      state: record.state,
      sequence: record.sequence,
      label: record.progress.label,
      index: record.progress.index,
      total: record.progress.total,
      error: record.error,
    });
  }

  /**
   * Сверка журнала с процессами при старте сервера. Живое задание возвращается
   * под наблюдение как есть, пропавшее получает `interrupted` с причиной. Пока
   * сверка не прошла, очередь не выдаёт новых заданий.
   */
  async function recover(): Promise<{ alive: number; interrupted: number }> {
    await fs.mkdir(jobsDir, { recursive: true, mode: 0o700 });

    let names: string[] = [];

    try {
      names = await fs.readdir(jobsDir);
    } catch {
      names = [];
    }

    let aliveCount = 0;
    let interruptedCount = 0;

    for (const id of names.filter((name) => JOB_FILE.test(name))) {
      let record: JobRecord;

      try {
        record = JSON.parse(await fs.readFile(fileOf(id), 'utf8')) as JobRecord;
      } catch {
        continue;
      }

      records.set(record.id, record);

      if (isTerminal(record.state)) {
        continue;
      }

      if (alive(record)) {
        aliveCount += 1;

        continue;
      }

      const stopped: JobRecord = {
        ...record,
        state: 'interrupted',
        sequence: record.sequence + 1,
        error: 'Исполнитель задания не пережил перезапуск кокпита.',
        finishedAt: new Date().toISOString(),
      };

      await persist(stopped);
      publish(stopped);
      interruptedCount += 1;
    }

    recovered = true;

    return { alive: aliveCount, interrupted: interruptedCount };
  }

  function assertRecovered(): void {
    if (!recovered) {
      throw new ShowcaseError(
        'not_recovered',
        'Кокпит ещё сверяет журнал заданий с процессами.',
        503,
      );
    }
  }

  function list(projectId?: string): JobRecord[] {
    const all = [...records.values()];
    const own = projectId ? all.filter((record) => record.projectId === projectId) : all;

    return own.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  function active(): JobRecord[] {
    return list().filter((record) => !isTerminal(record.state));
  }

  function read(id: string): JobRecord {
    const record = records.get(id);

    if (!record) {
      throw notFound('Задание не найдено.');
    }

    return record;
  }

  function findByStageKey(stageKey: string): JobRecord | null {
    return list().find((record) => record.stageKeys?.includes(stageKey)) ?? null;
  }

  /**
   * Контекст устойчивого ключа проходит через существующую операцию до enqueue,
   * не заставляя voice/record/assemble знать о полном координаторе.
   */
  function withStageKey<Value>(stageKey: string, task: () => Promise<Value>): Promise<Value> {
    return stageContext.run(stageKey, task);
  }

  /**
   * Заявка на задание. Совпадение ключа повтора с незавершённым заданием
   * возвращает его же: «Собрать» с теми же входами не создаёт второй прогон,
   * даже если кнопку нажали дважды или её нажали в двух вкладках.
   */
  async function enqueue(input: {
    projectId: string;
    kind: ShowcaseJob['kind'];
    idempotencyKey: string;
    inputHashes: Record<string, string>;
    inputRevision: number;
  }): Promise<{ record: JobRecord; reused: boolean }> {
    assertRecovered();

    const existing = active().find((record) => record.idempotencyKey === input.idempotencyKey);
    const stageKey = stageContext.getStore();

    if (existing) {
      if (stageKey && !existing.stageKeys?.includes(stageKey)) {
        const joined = {
          ...existing,
          stageKeys: [...(existing.stageKeys ?? []), stageKey],
        };

        await persist(joined);

        return { record: joined, reused: true };
      }

      return { record: existing, reused: true };
    }

    const { maxQueued, jobTimeoutMs } = options.limits();

    if (active().length >= maxQueued) {
      throw new ShowcaseError(
        'queue_full',
        `Очередь раздела заполнена: одновременно допускается ${maxQueued} заданий.`,
        429,
      );
    }

    const record: JobRecord = {
      id: newJobId(),
      projectId: input.projectId,
      kind: input.kind,
      state: 'queued',
      attempt: 1,
      sequence: 1,
      progress: { index: 0, total: 0, label: 'в очереди' },
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      idempotencyKey: input.idempotencyKey,
      ...(stageKey ? { stageKeys: [stageKey] } : {}),
      inputHashes: input.inputHashes,
      inputRevision: input.inputRevision,
      deadlineAt: new Date(Date.now() + jobTimeoutMs).toISOString(),
      heartbeatAt: null,
      identity: { pid: null, starttime: null, cmdline: null },
    };

    await persist(record);
    publish(record);

    return { record, reused: false };
  }

  /**
   * Отметка о ходе работы. Поздний отчёт прошлой попытки отбрасывается по номеру
   * сообщения: он приходит после того, как попытка уже сменилась, и подменил бы
   * статус новой работы старым.
   */
  async function progress(id: string, update: {
    sequence: number;
    index?: number;
    total?: number;
    label?: string;
    identity?: JobIdentity;
  }): Promise<JobRecord> {
    const record = read(id);

    if (update.sequence <= record.sequence || isTerminal(record.state)) {
      return record;
    }

    const next: JobRecord = {
      ...record,
      state: record.state === 'queued' ? 'running' : record.state,
      sequence: update.sequence,
      progress: {
        index: update.index ?? record.progress.index,
        total: update.total ?? record.progress.total,
        label: update.label ?? record.progress.label,
      },
      heartbeatAt: new Date().toISOString(),
      identity: update.identity ?? record.identity,
    };

    await persist(next);
    publish(next);

    return next;
  }

  /**
   * Завершение задания. Терминальное состояние окончательно: повторный отчёт
   * о том же задании его не меняет, а «Продолжить» заводит новую попытку.
   */
  async function finish(id: string, outcome: {
    state: Extract<
      ShowcaseJobState,
      'awaiting_review' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled'
    >;
    error?: string | null;
    label?: string;
  }): Promise<JobRecord> {
    const record = read(id);

    if (isTerminal(record.state)) {
      return record;
    }

    // Поздний успех функции после сохранённой отмены не возвращает задание в
    // succeeded: координатор увидит именно отмену и не запустит следующий этап.
    if (record.state === 'cancelling' && outcome.state !== 'interrupted') {
      outcome = {
        state: 'cancelled',
        error: null,
        label: 'отменено',
      };
    }

    const next: JobRecord = {
      ...record,
      state: outcome.state,
      sequence: record.sequence + 1,
      progress: { ...record.progress, label: outcome.label ?? record.progress.label },
      error: outcome.error ?? null,
      finishedAt: new Date().toISOString(),
    };

    await persist(next);
    publish(next);

    return next;
  }

  /**
   * Отмена. Заявка в очереди снимается сразу, идущая работа переходит в
   * `cancelling`: остановить дерево процессов должен исполнитель, и до его
   * подтверждения задание нельзя объявить завершённым.
   */
  async function cancel(id: string): Promise<JobRecord> {
    const record = read(id);

    if (isTerminal(record.state) || record.state === 'cancelling') {
      return record;
    }

    if (record.state === 'queued') {
      return finish(id, { state: 'cancelled', label: 'отменено до запуска' });
    }

    const next: JobRecord = {
      ...record,
      state: 'cancelling',
      sequence: record.sequence + 1,
      progress: { ...record.progress, label: 'останавливаем исполнителя' },
    };

    await persist(next);
    publish(next);

    return next;
  }

  /**
   * Просроченные задания. Deadline соблюдает и сервер, а не только исполнитель:
   * зависший worker обязан стать видимой причиной, а не бесконечным «идёт».
   */
  async function sweepExpired(): Promise<JobRecord[]> {
    const now = Date.now();
    const expired = active().filter((record) => Date.parse(record.deadlineAt) < now || !alive(record));
    const stopped: JobRecord[] = [];

    for (const record of expired) {
      // Задание, запущенное прямо в сервере, живёт в его памяти и снимка identity
      // не имеет: пока не истёк срок, оно считается идущим.
      if (!record.identity.pid && Date.parse(record.deadlineAt) >= now) {
        continue;
      }

      stopped.push(await finish(record.id, {
        state: 'interrupted',
        error: Date.parse(record.deadlineAt) < now
          ? 'Задание не уложилось в отведённый срок.'
          : 'Исполнитель задания перестал отвечать.',
      }));
    }

    return stopped;
  }

  /** Удаление ролика уносит и его задания: журнал не переживает свой предмет. */
  async function removeForProject(projectId: string): Promise<void> {
    for (const record of list(projectId)) {
      records.delete(record.id);
      await fs.rm(path.join(jobsDir, record.id), { recursive: true, force: true });
    }
  }

  return {
    active,
    cancel,
    enqueue,
    findByStageKey,
    finish,
    list,
    progress,
    read,
    recover,
    removeForProject,
    sweepExpired,
    withStageKey,
  };
}

export type ShowcaseJobs = ReturnType<typeof createShowcaseJobs>;
