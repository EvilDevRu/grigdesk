// Сохраняемый журнал полного запуска ролика.
//
// BuildRun намеренно не является ShowcaseJob: координатор ждёт дочерние задания,
// поэтому при maxQueued=1 сам занял бы единственное место и навсегда заблокировал
// первый этап. Здесь хранятся только управление последовательностью и снимок
// содержательных входов; процессы и тяжёлые результаты по-прежнему принадлежат jobs.
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { isRecord } from '../../../../shared/lib/objects.ts';

import {
  SHOWCASE_BUILD_REQUEST_ID_RE,
  SHOWCASE_BUILD_STAGES,
  SHOWCASE_BUILD_STATES,
} from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import type {
  ShowcaseBuildRun,
  ShowcaseBuildStage,
  ShowcaseBuildState,
  ShowcaseBuildStopReason,
  ShowcaseFinal,
  ShowcaseJobState,
} from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import { notFound, ShowcaseError } from './errors.ts';

export const SHOWCASE_BUILD_RUN_VERSION = 1 as const;
export const SHOWCASE_BUILD_RUN_ID_RE = /^[a-f0-9]{16}$/;

const HASH_RE = /^[a-f0-9]{32}$/;
const TERMINAL = new Set<ShowcaseBuildState>([
  'awaiting_review',
  'succeeded',
  'failed',
  'interrupted',
  'cancelled',
]);
const BUILD_STAGES = new Set<string>(SHOWCASE_BUILD_STAGES);
const BUILD_STATES = new Set<string>(SHOWCASE_BUILD_STATES);
const JOB_STATES = new Set<ShowcaseJobState>([
  'queued',
  'running',
  'awaiting_review',
  'cancelling',
  'succeeded',
  'failed',
  'interrupted',
  'cancelled',
]);
const MAX_REQUEST_ALIASES = 64;

export interface BuildRunSnapshot {
  inputHash: string;
  targetHash: string;
  scriptBaseHash: string;
  withoutBindingsHash: string;
  withoutVoiceHash: string;
  sceneIds: string[];
}

export interface BuildRunChildRecord {
  stage: ShowcaseBuildStage;
  jobId: string;
  attempt: number;
  stageKey: string;
  state: ShowcaseJobState;
}

export interface BuildRunRecord {
  version: typeof SHOWCASE_BUILD_RUN_VERSION;
  id: string;
  projectId: string;
  state: ShowcaseBuildState;
  sequence: number;
  stage: ShowcaseBuildStage;
  initialRevision: number;
  requestIds: string[];
  requestInputHash: string;
  snapshot: BuildRunSnapshot;
  // Предыдущая опубликованная ссылка нужна только для отмены на границе assemble:
  // если старый in-process исполнитель всё же успел записать новую, вернём эту.
  previousFinal: ShowcaseFinal | null;
  children: BuildRunChildRecord[];
  cancelRequested: boolean;
  error: ShowcaseBuildStopReason | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ShowcaseBuildRunsOptions {
  runsDir: string;
  broadcast: (event: string, data: unknown) => void;
  limits: () => { retentionDays: number; maxRuns?: number };
}

function isWhole(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function stringList(value: unknown, check: (entry: string) => boolean): value is string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === 'string' && check(entry));
}

function snapshotOf(value: unknown): BuildRunSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const hashes = [
    value.inputHash,
    value.targetHash,
    value.scriptBaseHash,
    value.withoutBindingsHash,
    value.withoutVoiceHash,
  ];

  if (
    hashes.some((hash) => typeof hash !== 'string' || !HASH_RE.test(hash))
    || !stringList(value.sceneIds, (id) => id.length > 0 && id.length <= 128)
  ) {
    return null;
  }

  return {
    inputHash: value.inputHash as string,
    targetHash: value.targetHash as string,
    scriptBaseHash: value.scriptBaseHash as string,
    withoutBindingsHash: value.withoutBindingsHash as string,
    withoutVoiceHash: value.withoutVoiceHash as string,
    sceneIds: [...value.sceneIds],
  };
}

function childOf(value: unknown): BuildRunChildRecord | null {
  if (
    !isRecord(value)
    || typeof value.stage !== 'string'
    || !BUILD_STAGES.has(value.stage)
    || typeof value.jobId !== 'string'
    || value.jobId.length === 0
    || !isWhole(value.attempt, 1)
    || typeof value.stageKey !== 'string'
    || value.stageKey.length === 0
    || value.stageKey.length > 160
    || typeof value.state !== 'string'
    || !JOB_STATES.has(value.state as ShowcaseJobState)
  ) {
    return null;
  }

  return {
    stage: value.stage as ShowcaseBuildStage,
    jobId: value.jobId,
    attempt: value.attempt,
    stageKey: value.stageKey,
    state: value.state as ShowcaseJobState,
  };
}

function stopReasonOf(value: unknown): ShowcaseBuildStopReason | null | undefined {
  if (value === null) {
    return null;
  }

  if (
    !isRecord(value)
    || typeof value.code !== 'string'
    || value.code.length === 0
    || typeof value.message !== 'string'
    || value.message.length === 0
  ) {
    return undefined;
  }

  return { code: value.code, message: value.message };
}

function artifactRefLike(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.kind === 'string'
    && typeof value.inputHash === 'string'
    && typeof value.contentHash === 'string'
    && typeof value.producerVersion === 'string'
    && (value.durationMs === null || isWhole(value.durationMs))
    && isWhole(value.byteSize);
}

function finalOf(value: unknown): ShowcaseFinal | null | undefined {
  if (value === null) {
    return null;
  }

  if (
    !isRecord(value)
    || !artifactRefLike(value.video)
    || !(value.subtitles === null || artifactRefLike(value.subtitles))
    || typeof value.manifestId !== 'string'
    || !(value.manifestVersion === null || value.manifestVersion === 1)
    || typeof value.builtAt !== 'string'
    || typeof value.current !== 'boolean'
  ) {
    return undefined;
  }

  return value as ShowcaseFinal;
}

/**
 * Внутренний codec не доверяет даже собственному JSON: битая запись запуска не
 * должна получить путь из поля id или оживить терминальное состояние.
 */
function runRecordOf(value: unknown): BuildRunRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const snapshot = snapshotOf(value.snapshot);
  const error = stopReasonOf(value.error);
  const previousFinal = finalOf(value.previousFinal);
  const children = Array.isArray(value.children) ? value.children.map(childOf) : [];

  if (
    value.version !== SHOWCASE_BUILD_RUN_VERSION
    || typeof value.id !== 'string'
    || !SHOWCASE_BUILD_RUN_ID_RE.test(value.id)
    || typeof value.projectId !== 'string'
    || value.projectId.length === 0
    || typeof value.state !== 'string'
    || !BUILD_STATES.has(value.state)
    || typeof value.stage !== 'string'
    || !BUILD_STAGES.has(value.stage)
    || !isWhole(value.sequence, 1)
    || !isWhole(value.initialRevision, 1)
    || !stringList(value.requestIds, (id) => SHOWCASE_BUILD_REQUEST_ID_RE.test(id))
    || value.requestIds.length === 0
    || value.requestIds.length > MAX_REQUEST_ALIASES
    || new Set(value.requestIds).size !== value.requestIds.length
    || typeof value.requestInputHash !== 'string'
    || !HASH_RE.test(value.requestInputHash)
    || !snapshot
    || previousFinal === undefined
    || children.some((child) => child === null)
    || typeof value.cancelRequested !== 'boolean'
    || error === undefined
    || typeof value.startedAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !(value.finishedAt === null || typeof value.finishedAt === 'string')
  ) {
    return null;
  }

  return {
    version: SHOWCASE_BUILD_RUN_VERSION,
    id: value.id,
    projectId: value.projectId,
    state: value.state as ShowcaseBuildState,
    sequence: value.sequence,
    stage: value.stage as ShowcaseBuildStage,
    initialRevision: value.initialRevision,
    requestIds: [...value.requestIds],
    requestInputHash: value.requestInputHash,
    snapshot,
    previousFinal,
    children: children as BuildRunChildRecord[],
    cancelRequested: value.cancelRequested,
    error,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    finishedAt: value.finishedAt,
  };
}

export function newBuildRunId(): string {
  return randomBytes(8).toString('hex');
}

export function isBuildRunTerminal(state: ShowcaseBuildState): boolean {
  return TERMINAL.has(state);
}

/** Публичная проекция не содержит ключи повторов и хеши рабочего снимка. */
export function toPublicBuildRun(record: BuildRunRecord): ShowcaseBuildRun {
  return {
    id: record.id,
    projectId: record.projectId,
    state: record.state,
    sequence: record.sequence,
    stage: record.stage,
    initialRevision: record.initialRevision,
    children: record.children.map(({ stage, jobId, attempt, state }) => ({
      stage,
      jobId,
      attempt,
      state,
    })),
    cancelRequested: record.cancelRequested,
    error: record.error,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    finishedAt: record.finishedAt,
  };
}

export function createShowcaseBuildRuns(options: ShowcaseBuildRunsOptions) {
  const { runsDir, broadcast } = options;
  const records = new Map<string, BuildRunRecord>();

  let recovered = false;
  let mutation = Promise.resolve<unknown>(undefined);

  function fileOf(id: string): string {
    return path.join(runsDir, `${id}.json`);
  }

  function locked<Value>(task: () => Promise<Value>): Promise<Value> {
    const next = mutation.catch(() => undefined).then(task);

    mutation = next.catch(() => undefined);

    return next;
  }

  async function persist(record: BuildRunRecord): Promise<void> {
    const file = fileOf(record.id);
    const temporary = `${file}.tmp-${randomBytes(4).toString('hex')}`;

    await fs.mkdir(runsDir, { recursive: true, mode: 0o700 });

    try {
      await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => null);
      throw error;
    }

    records.set(record.id, record);
  }

  function publish(record: BuildRunRecord): void {
    broadcast('showcase-build-progress', {
      runId: record.id,
      projectId: record.projectId,
      state: record.state,
      sequence: record.sequence,
      stage: record.stage,
      error: record.error,
    });
  }

  function assertRecovered(): void {
    if (!recovered) {
      throw new ShowcaseError(
        'builds_not_recovered',
        'Кокпит ещё восстанавливает журнал полных запусков.',
        503,
      );
    }
  }

  function read(id: string): BuildRunRecord {
    const record = records.get(id);

    if (!record) {
      throw notFound('Полный запуск ролика не найден.');
    }

    return record;
  }

  function list(projectId?: string): BuildRunRecord[] {
    const all = [...records.values()];
    const own = projectId ? all.filter((record) => record.projectId === projectId) : all;

    return own.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  function active(projectId?: string): BuildRunRecord[] {
    return list(projectId).filter((record) => !isBuildRunTerminal(record.state));
  }

  function findByRequestId(requestId: string): BuildRunRecord | null {
    return list().find((record) => record.requestIds.includes(requestId)) ?? null;
  }

  async function quarantine(file: string): Promise<void> {
    const stamp = new Date().toISOString().replaceAll(':', '-');

    await fs.rename(file, `${file}.broken-${stamp}`).catch(() => null);
  }

  /**
   * Старые терминальные записи очищаются по тому же сроку, что и ролики. Кроме
   * срока действует жёсткий предел: сначала уходят самые старые завершённые,
   * активный запуск ради освобождения места никогда не удаляется.
   */
  async function sweepUnlocked(now = Date.now()): Promise<number> {
    const retentionDays = options.limits().retentionDays;
    const retentionMs = Number.isFinite(retentionDays) && retentionDays > 0
      ? retentionDays * 24 * 60 * 60 * 1000
      : Number.POSITIVE_INFINITY;
    const maxRuns = Math.max(1, Math.floor(options.limits().maxRuns ?? 200));
    const removable = list()
      .filter((record) => isBuildRunTerminal(record.state))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const remove = new Set<string>();

    for (const record of removable) {
      const age = now - Date.parse(record.updatedAt);

      if (Number.isFinite(age) && age > retentionMs) {
        remove.add(record.id);
      }
    }

    for (const record of removable) {
      if (records.size - remove.size <= maxRuns) {
        break;
      }

      remove.add(record.id);
    }

    for (const id of remove) {
      records.delete(id);
      await fs.rm(fileOf(id), { force: true });
    }

    return remove.size;
  }

  /**
   * Восстановление читает только файлы с серверным id. Две активные записи одного
   * ролика не продолжаются одновременно: более поздняя отмечается оборванной,
   * а первый владелец проекта остаётся единственным координатором.
   */
  async function recover(): Promise<{ active: number; corrupted: number }> {
    return locked(async () => {
      await fs.mkdir(runsDir, { recursive: true, mode: 0o700 });

      records.clear();

      const names = await fs.readdir(runsDir).catch(() => [] as string[]);
      let corrupted = 0;

      for (const name of names.filter((entry) => SHOWCASE_BUILD_RUN_ID_RE.test(
        entry.replace(/\.json$/, ''),
      ) && entry.endsWith('.json'))) {
        const file = path.join(runsDir, name);

        try {
          const parsed = runRecordOf(JSON.parse(await fs.readFile(file, 'utf8')));

          if (!parsed || `${parsed.id}.json` !== name) {
            corrupted += 1;
            await quarantine(file);

            continue;
          }

          records.set(parsed.id, parsed);
        } catch {
          corrupted += 1;
          await quarantine(file);
        }
      }

      const owners = new Map<string, BuildRunRecord>();

      for (const record of [...active()].sort((left, right) => (
        left.startedAt.localeCompare(right.startedAt)
      ))) {
        if (!owners.has(record.projectId)) {
          owners.set(record.projectId, record);

          continue;
        }

        const stopped: BuildRunRecord = {
          ...record,
          state: 'interrupted',
          sequence: record.sequence + 1,
          error: {
            code: 'duplicate_active_run',
            message: 'После восстановления найден второй активный запуск этого ролика.',
          },
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };

        await persist(stopped);
        publish(stopped);
      }

      await sweepUnlocked();
      recovered = true;

      return { active: active().length, corrupted };
    });
  }

  /**
   * Создание под одной блокировкой закрывает двойной клик из двух клиентов.
   * Один requestId навсегда обозначает одни первоначальные входы; новый ключ с
   * тем же текущим снимком присоединяется к активному запуску проекта.
   */
  async function create(input: {
    projectId: string;
    initialRevision: number;
    requestId: string;
    requestInputHash: string;
    snapshot: BuildRunSnapshot;
    previousFinal: ShowcaseFinal | null;
  }): Promise<{ record: BuildRunRecord; reused: boolean }> {
    return locked(async () => {
      assertRecovered();

      const requested = findByRequestId(input.requestId);

      if (requested) {
        if (
          requested.projectId !== input.projectId
          || requested.initialRevision !== input.initialRevision
          || requested.requestInputHash !== input.requestInputHash
        ) {
          throw new ShowcaseError(
            'build_request_conflict',
            'Этот requestId уже использован для других входов сборки.',
            409,
          );
        }

        return { record: requested, reused: true };
      }

      const running = active(input.projectId)[0];

      if (running) {
        if (
          input.requestInputHash !== running.requestInputHash
          && input.requestInputHash !== running.snapshot.inputHash
        ) {
          throw new ShowcaseError(
            'build_already_running',
            'Для этого ролика уже идёт запуск с другими входами.',
            409,
          );
        }

        if (running.requestIds.length >= MAX_REQUEST_ALIASES) {
          throw new ShowcaseError(
            'build_request_limit',
            'У активного запуска слишком много ключей повтора.',
            429,
          );
        }

        const joined: BuildRunRecord = {
          ...running,
          sequence: running.sequence + 1,
          requestIds: [...running.requestIds, input.requestId],
          updatedAt: new Date().toISOString(),
        };

        await persist(joined);
        publish(joined);

        return { record: joined, reused: true };
      }

      await sweepUnlocked();

      const maxRuns = Math.max(1, Math.floor(options.limits().maxRuns ?? 200));

      if (records.size >= maxRuns) {
        throw new ShowcaseError(
          'build_run_limit',
          `Журнал полных запусков заполнен: допускается ${maxRuns} записей.`,
          429,
        );
      }

      const now = new Date().toISOString();
      const record: BuildRunRecord = {
        version: SHOWCASE_BUILD_RUN_VERSION,
        id: newBuildRunId(),
        projectId: input.projectId,
        state: 'queued',
        sequence: 1,
        stage: 'preflight',
        initialRevision: input.initialRevision,
        requestIds: [input.requestId],
        requestInputHash: input.requestInputHash,
        snapshot: input.snapshot,
        previousFinal: input.previousFinal,
        children: [],
        cancelRequested: false,
        error: null,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
      };

      await persist(record);
      publish(record);

      return { record, reused: false };
    });
  }

  async function change(
    id: string,
    mutate: (record: BuildRunRecord) => BuildRunRecord,
  ): Promise<BuildRunRecord> {
    return locked(async () => {
      const current = read(id);
      const next = mutate(current);

      if (next === current) {
        return current;
      }

      await persist(next);
      publish(next);

      return next;
    });
  }

  async function move(
    id: string,
    stage: ShowcaseBuildStage,
    snapshot?: BuildRunSnapshot,
  ): Promise<BuildRunRecord> {
    return change(id, (current) => {
      if (isBuildRunTerminal(current.state) || current.cancelRequested) {
        return current;
      }

      return {
        ...current,
        state: 'running',
        sequence: current.sequence + 1,
        stage,
        snapshot: snapshot ?? current.snapshot,
        error: null,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function attachChild(
    id: string,
    child: BuildRunChildRecord,
  ): Promise<BuildRunRecord> {
    return change(id, (current) => {
      if (
        isBuildRunTerminal(current.state)
        || current.cancelRequested
        || current.stage !== child.stage
        || current.children.some((entry) => entry.jobId === child.jobId)
      ) {
        return current;
      }

      return {
        ...current,
        state: 'running',
        sequence: current.sequence + 1,
        children: [...current.children, child],
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function observeChild(
    id: string,
    jobId: string,
    state: ShowcaseJobState,
  ): Promise<BuildRunRecord> {
    return change(id, (current) => {
      const own = current.children.find((child) => child.jobId === jobId);

      if (!own || own.state === state) {
        return current;
      }

      return {
        ...current,
        sequence: current.sequence + 1,
        children: current.children.map((child) => (
          child.jobId === jobId ? { ...child, state } : child
        )),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  /** Отмена сначала становится фактом журнала; дочернее job снимает координатор. */
  async function requestCancel(id: string): Promise<BuildRunRecord> {
    return change(id, (current) => {
      if (isBuildRunTerminal(current.state) || current.cancelRequested) {
        return current;
      }

      return {
        ...current,
        state: 'cancelling',
        sequence: current.sequence + 1,
        cancelRequested: true,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function finish(
    id: string,
    state: Extract<
      ShowcaseBuildState,
      'awaiting_review' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled'
    >,
    error: ShowcaseBuildStopReason | null,
  ): Promise<BuildRunRecord> {
    return change(id, (current) => {
      if (isBuildRunTerminal(current.state)) {
        return current;
      }

      const now = new Date().toISOString();
      const finalState = current.cancelRequested && state !== 'cancelled'
        ? 'cancelled'
        : state;

      return {
        ...current,
        state: finalState,
        sequence: current.sequence + 1,
        stage: finalState === 'succeeded' ? 'done' : current.stage,
        error: finalState === 'cancelled' ? null : error,
        updatedAt: now,
        finishedAt: now,
      };
    });
  }

  async function sweep(): Promise<number> {
    return locked(() => sweepUnlocked());
  }

  /** Удаление ролика уносит его журнал запусков после их отмены службой. */
  async function removeForProject(projectId: string): Promise<void> {
    await locked(async () => {
      for (const record of list(projectId)) {
        records.delete(record.id);
        await fs.rm(fileOf(record.id), { force: true });
      }
    });
  }

  return {
    active,
    attachChild,
    create,
    findByRequestId,
    finish,
    list,
    move,
    observeChild,
    read,
    recover,
    removeForProject,
    requestCancel,
    runsDir,
    sweep,
  };
}

export type ShowcaseBuildRuns = ReturnType<typeof createShowcaseBuildRuns>;
