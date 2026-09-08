// Жизненный цикл ручной песочницы: подъём, слежение за прогрессом и снос.
//
// ГРАНИЦА. Стенд поднимает и сносит СКРИПТ ПРОФИЛЯ (up.sh/down.sh) — кокпит не знает
// ни про контейнеры, ни про схемы. Его дело: выдать слот тем же распределителем, что
// и перед запуском конвейера, снять fail-closed гард подъёма, запомнить запуск в
// журнале и довести до человека прогресс и отказ.
//
// ПОЧЕМУ ГАРД СНИМАЕТ КОКПИТ. `up.sh` без `FACTORY_WORKSPACE_MODE=isolated` и
// `FACTORY_REQUIRE_NEW_SANDBOX=1` отказывается подниматься: занять слот на четверть
// часа не должен ни агент, ни случайный вызов. Раздел «Песочницы» — второе место,
// где это решение принимает ЧЕЛОВЕК: его ручки закрыты сессией.
//
// ЧУЖОЕ НЕ ТРОГАЕМ. Стенд с реестром конвейера (t<номер>.pipeline) принадлежит попытке
// движка, стенд общего checkout (WORKSPACE_MODE=shared) — вообще не наш: у обоих свой
// владелец и свой жизненный цикл. Здесь такие стенды только показываются.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { readLaunchLog } from '../factory-route-cli.js';
import { listFactoryProfiles, PROFILE_RE } from '../profiles.js';
import { releaseSlot, reservedTasks, reserveSlot } from '../sandbox-slots.js';
import { readProcessIdentity } from '../speech/model-jobs-process.js';
import { SANDBOX_TASK_RE, toSandboxJob } from '../../../../shared/sandboxContracts.ts';
import type {
  SandboxActionResponse,
  SandboxEntry,
  SandboxJournalRecord,
  SandboxOverview,
  SandboxProfile,
} from '../../../../shared/sandboxContracts.ts';
import {
  fileExists,
  hasPipelineRegistry,
  readSandboxJournal,
  readSandboxJournalRecord,
  readSandboxRegistry,
  readSandboxStage,
  writeSandboxJournalRecord,
} from './registry.ts';
import type { SandboxRegistryEntry } from './registry.ts';

export interface SandboxServiceOptions {
  stateDir: string;
  journalDir: string;
  profilesDir: string;
  factoryBin: string;
  manualRange: {
    from: number;
    to: number;
  };
  downCmd?: string;
  broadcast?: (event: string, data: unknown) => void;
  subscribe?: (listener: (event: string, data: unknown) => void) => () => void;
  sweepMs?: number;
  probe?: (port: number) => Promise<boolean>;
}

export interface SandboxRaiseInput {
  profile: string;
  task: string | null;
}

export interface SandboxDismantleInput {
  task: string;
  force?: boolean;
}

export interface SandboxService {
  overview(): Promise<SandboxOverview>;
  raise(input: SandboxRaiseInput): Promise<SandboxActionResponse>;
  dismantle(input: SandboxDismantleInput): Promise<SandboxActionResponse>;
  resume(): Promise<void>;
  stop(): void;
}

const DEFAULT_SWEEP_MS = 15000;
const PROBE_TIMEOUT_MS = 250;
const MESSAGE_LIMIT = 600;
// Завершённое задание живёт в обзоре ещё полчаса: стенда в реестре уже нет, а итог
// сноса и причину упавшего подъёма человек обязан увидеть.
const RECENT_JOB_MS = 30 * 60 * 1000;

/** Отказ раздела с HTTP-статусом: маршрут отвечает кодом службы, а не общей ошибкой. */
export class SandboxError extends Error {
  status: number;

  code: string;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Живость стенда проверяется реальностью — ответом порта. Реестр переживает и
 * остановленные контейнеры, и убитый руками стенд, а профильный ответ на этот
 * вопрос (`profile_stand_alive`) кокпиту недоступен без запуска bash профиля.
 */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Жив ли процесс задания. Одного pid мало: номер переиспользуется, и после ночной
 * перезагрузки посторонний процесс оставил бы мёртвый подъём вечно «идущим».
 * Сверяем снимок identity (время старта и командную строку), снятый при запуске;
 * без снимка остаётся обычная проверка существования процесса.
 */
function processAlive(record: SandboxJournalRecord): boolean {
  if (!record.pid) {
    return false;
  }

  const actual = readProcessIdentity(record.pid);

  if (!actual) {
    return false;
  }

  if (!record.starttime || !record.cmdline) {
    return true;
  }

  return actual.starttime === record.starttime && actual.cmdline === record.cmdline;
}

/**
 * Стенд принадлежит разделу только когда он изолированный и заведён самой задачей.
 * Общий checkout и внешний стенд профиля живут по чужим правилам: их не поднимают
 * и не сносят отсюда.
 */
function ownedByTask(entry: SandboxRegistryEntry): boolean {
  return !entry.pipeline
    && entry.workspaceMode !== 'shared'
    && entry.standOwnership !== 'external';
}

export function createSandboxService(options: SandboxServiceOptions): SandboxService {
  const {
    stateDir,
    journalDir,
    profilesDir,
    factoryBin,
    manualRange,
    downCmd = '',
    broadcast = () => {},
    subscribe = null,
    sweepMs = DEFAULT_SWEEP_MS,
    probe = probePort,
  } = options;

  // Живые задания держатся в памяти: тик слежения обязан стоить одно чтение журнала
  // этапов на задание, а не обход всего журнала установки.
  const running = new Map<string, SandboxJournalRecord>();
  let sweep: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  function announce(event: string, payload: unknown) {
    try {
      broadcast(event, payload);
    } catch {
      // Обрыв SSE не должен ронять подъём: состояние всё равно лежит в журнале.
    }
  }

  async function save(record: SandboxJournalRecord) {
    if (record.state === 'running') {
      running.set(record.task, record);
    } else {
      running.delete(record.task);
    }

    await writeSandboxJournalRecord(journalDir, record);
    announce('sandbox-progress', toSandboxJob(record));
  }

  /**
   * Профили, которые вообще умеют песочницу. Признак — те самые скрипты, которые
   * зовёт движок: profiles/<профиль>/up.sh и down.sh. Догадок по косвенным
   * признакам здесь нет, поэтому профиль без них в списке подъёма не появляется.
   */
  async function profiles(): Promise<SandboxProfile[]> {
    // Список приходит из JS-библиотеки профилей, поэтому форма имён подтверждается
    // здесь: дальше по коду профиль подставляется в путь к скрипту подъёма.
    const names: string[] = (await listFactoryProfiles(profilesDir))
      .filter((id: unknown): id is string => typeof id === 'string');

    return Promise.all(names.map(async (id: string) => {
      const [up, down] = await Promise.all([
        fileExists(path.join(profilesDir, id, 'up.sh')),
        fileExists(path.join(profilesDir, id, 'down.sh')),
      ]);
      const missing = [up ? '' : 'up.sh', down ? '' : 'down.sh'].filter(Boolean);

      return {
        id,
        canRaise: missing.length === 0,
        reason: missing.length === 0 ? null : `профиль не объявил ${missing.join(' и ')}`,
      };
    }));
  }

  async function requireProfile(profile: string): Promise<void> {
    if (!PROFILE_RE.test(String(profile || ''))) {
      throw new SandboxError('bad_profile', 'имя профиля имеет недопустимую форму', 400);
    }

    const known = await profiles();
    const found = known.find((item) => item.id === profile);

    if (!found) {
      throw new SandboxError('profile_unknown', `профиль ${profile} не найден`, 404);
    }

    if (!found.canRaise) {
      throw new SandboxError('sandbox_unsupported', found.reason || 'профиль не умеет песочницы');
    }
  }

  /**
   * Чей down.sh звать. Обычно профиль известен из журнала собственного подъёма;
   * стенд, поднятый мимо кокпита, опознаётся только когда песочницу на машине
   * умеет ровно один профиль. Иначе снос остаётся человеку и его терминалу.
   */
  function ownerOf(record: SandboxJournalRecord | null, capable: string[]): string | null {
    if (record?.profile) {
      return record.profile;
    }

    return capable.length === 1 ? capable[0] ?? null : null;
  }

  function requireTask(task: string): string {
    if (!SANDBOX_TASK_RE.test(task)) {
      throw new SandboxError('bad_task', 'номер стенда должен быть целым числом', 400);
    }

    return task;
  }

  /**
   * Первый свободный номер служебного диапазона. Занятыми считаются реестр стендов,
   * живое задание и резервация слота, причём про живость резервации спрашивается сам
   * распределитель: правило протухания принадлежит ему, а не этому обходу.
   */
  function freeManualTask(
    registry: SandboxRegistryEntry[],
    journal: SandboxJournalRecord[],
  ): string {
    const taken = new Set<string>([
      ...registry.map((entry) => entry.task),
      ...journal.filter((record) => record.state === 'running').map((record) => record.task),
      ...reservedTasks({ stateDir }),
    ]);

    for (let candidate = manualRange.from; candidate <= manualRange.to; candidate += 1) {
      if (!taken.has(String(candidate))) {
        return String(candidate);
      }
    }

    throw new SandboxError(
      'no_free_task',
      `свободных служебных номеров в диапазоне ${manualRange.from}-${manualRange.to} нет`,
    );
  }

  /**
   * Запуск скрипта профиля отдельным процессом: подъём идёт минутами, поэтому он
   * не привязан к запросу и переживает перезапуск сервера. Вывод уходит в журнал
   * рядом с записью — по нему человек читает причину отказа. Identity процесса
   * (starttime + cmdline) пишется в запись: одного pid мало, номер после ночной
   * перезагрузки достаётся постороннему процессу.
   */
  async function launch(
    record: SandboxJournalRecord,
    command: { file: string; args: string[] },
    env: Record<string, string>,
  ): Promise<SandboxJournalRecord> {
    await fs.mkdir(journalDir, { recursive: true });

    const log = await fs.open(record.log, 'a');
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, ...env },
    });
    const identity = child.pid ? readProcessIdentity(child.pid) : null;
    const started: SandboxJournalRecord = {
      ...record,
      pid: child.pid ?? null,
      starttime: identity?.starttime ?? null,
      cmdline: identity?.cmdline ?? null,
    };
    const saved = save(started);

    // Подписка на выход идёт СРАЗУ за spawn: скрипт умеет отказать на первой же
    // проверке, и подписка после await пропустила бы такой выход целиком.
    child.on('exit', (code) => {
      void saved.then(() => finish(record.task, code === 0));
    });

    await saved;
    await log.close();
    child.unref();
    watch();

    return started;
  }

  /**
   * Итог задания: у подъёма правду о причине знает журнал этапов профиля, у сноса —
   * его собственный вывод (там же предупреждение об оставленном worktree).
   */
  async function finish(task: string, ok: boolean) {
    const record = running.get(task) || await readSandboxJournalRecord(journalDir, task);

    if (!record || record.state !== 'running') {
      running.delete(task);

      return;
    }

    const [stage, output] = await Promise.all([
      record.action === 'up' ? readSandboxStage(stateDir, task) : Promise.resolve(null),
      readLaunchLog(record.log, MESSAGE_LIMIT),
    ]);
    const failed = !ok || stage?.state === 'failed';

    if (!failed && record.action === 'down') {
      releaseSlot({ stateDir, task });
    }

    await save({
      ...record,
      state: failed ? 'failed' : 'done',
      index: stage?.index ?? record.index,
      total: stage?.total ?? record.total,
      label: stage?.label || record.label,
      message: failed ? (output || stage?.label || 'процесс завершился с ошибкой') : output,
      finishedAt: new Date().toISOString(),
    });
    announce('sandboxes-changed', { task });
  }

  /**
   * Обход живых заданий: свежий шаг подъёма и процессы, потерянные после перезапуска.
   * Идёт по карте в памяти, поэтому стоимость не зависит от возраста установки.
   */
  async function refresh() {
    for (const record of [...running.values()]) {
      if (!processAlive(record)) {
        await finish(record.task, false);

        continue;
      }

      const stage = record.action === 'up' ? await readSandboxStage(stateDir, record.task) : null;

      if (stage && (stage.index !== record.index || stage.label !== record.label)) {
        await save({
          ...record,
          index: stage.index,
          total: stage.total,
          label: stage.label,
        });
      }
    }

    if (!running.size && sweep) {
      clearInterval(sweep);
      sweep = null;
    }
  }

  /**
   * Слежение за подъёмом: шаги ловит общий вотчер каталога состояния (профиль пишет
   * журнал этапов туда же), а редкий проход остаётся страховкой на случай, когда
   * процесс умер, ничего не записав. Второго вотчера того же каталога не заводим.
   */
  function watch() {
    if (subscribe && !unsubscribe) {
      unsubscribe = subscribe((event) => {
        if (event === 'state-change' && running.size) {
          void refresh();
        }
      });
    }

    if (!sweep && running.size) {
      sweep = setInterval(() => {
        void refresh();
      }, sweepMs);
      sweep.unref?.();
    }
  }

  /** Стенд как его видит человек: реестр + владелец + живость портов. */
  async function describe(
    entry: SandboxRegistryEntry,
    journal: Map<string, SandboxJournalRecord>,
    capable: string[],
  ): Promise<SandboxEntry> {
    const record = journal.get(entry.task) || null;
    const ports = [entry.apiPort, entry.fePort].filter((port): port is number => Boolean(port));
    const alive = ports.length
      ? (await Promise.all(ports.map((port) => probe(port)))).some(Boolean)
      : null;
    const owned = ownedByTask(entry);
    const profile = owned ? ownerOf(record, capable) : record?.profile ?? null;
    const reason = !owned
      ? 'pipeline_owned' as const
      : record?.state === 'running'
        ? 'job_running' as const
        : profile ? null : 'unknown_owner' as const;

    return {
      task: entry.task,
      profile,
      owner: owned ? 'manual' : 'pipeline',
      slot: entry.slot,
      fePort: entry.fePort,
      apiPort: entry.apiPort,
      repos: entry.repos,
      standAlive: alive,
      removable: reason === null,
      removableReason: reason,
      updatedAt: entry.updatedAt,
    };
  }

  /**
   * Задания, которые ещё кому-то нужны: по живым стендам, незавершённые и свежие.
   * Журнал не чистится (он же — история запусков), но возить его целиком незачем:
   * тело обзора иначе растёт с каждым поднятым за всю жизнь машины стендом.
   */
  function visibleJobs(journal: SandboxJournalRecord[], registry: SandboxRegistryEntry[]) {
    const known = new Set(registry.map((entry) => entry.task));
    const since = Date.now() - RECENT_JOB_MS;

    return journal
      .filter((record) => known.has(record.task)
        || record.state === 'running'
        || Date.parse(record.finishedAt || '') > since)
      .map(toSandboxJob);
  }

  return {
    async overview() {
      const [registry, journal, known] = await Promise.all([
        readSandboxRegistry(stateDir),
        readSandboxJournal(journalDir),
        profiles(),
      ]);
      const byTask = new Map(journal.map((record) => [record.task, record]));
      const capable = known.filter((item) => item.canRaise).map((item) => item.id);
      const sandboxes = await Promise.all(
        registry.map((entry) => describe(entry, byTask, capable)),
      );

      return {
        profiles: known,
        sandboxes,
        jobs: visibleJobs(journal, registry),
        manualRange,
      };
    },

    async raise(input) {
      await requireProfile(input.profile);

      const [registry, journal] = await Promise.all([
        readSandboxRegistry(stateDir),
        readSandboxJournal(journalDir),
      ]);
      const task = input.task === null
        ? freeManualTask(registry, journal)
        : requireTask(String(input.task));
      const entry = registry.find((item) => item.task === task) || null;

      // Реестр конвейера спрашиваем отдельно: попытка движка может существовать и
      // до того, как стенд поднят, — тогда записи в реестре стендов ещё нет.
      if (entry ? !ownedByTask(entry) : await hasPipelineRegistry(stateDir, task)) {
        throw new SandboxError(
          'pipeline_owned',
          'этой задачей владеет конвейер — стенд поднимается и сносится в разделе «Конвейер»',
        );
      }

      if (entry) {
        throw new SandboxError('sandbox_exists', `стенд ${task} уже поднят`);
      }

      if (journal.some((record) => record.task === task && record.state === 'running')) {
        throw new SandboxError('job_running', `по стенду ${task} уже идёт работа`);
      }

      let slot: number | null = null;

      try {
        const reservation = await reserveSlot({
          factoryBin, stateDir, profilesDir, profile: input.profile, task,
        });
        slot = typeof reservation.k === 'number' ? reservation.k : null;
      } catch (error) {
        // Занятые слоты и сломанный распределитель — разные беды: первую человек чинит
        // сносом лишнего стенда, вторую — профилем. Один код на двоих врал бы обоим.
        const full = error instanceof Error && error.name === 'SlotsFullError';
        const reason = error instanceof Error ? error.message : 'слот не выдан';

        throw new SandboxError(full ? 'slots_full' : 'slots_unavailable', reason);
      }

      const record: SandboxJournalRecord = {
        task,
        profile: input.profile,
        action: 'up',
        state: 'running',
        index: 0,
        total: 0,
        label: 'запуск подъёма',
        message: '',
        pid: null,
        starttime: null,
        cmdline: null,
        log: path.join(journalDir, `t${task}.up.log`),
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      // Ровно тот же вызов, что делает движок: гард снимается явно и целиком, а
      // слот приходит из общего распределителя, чтобы два подъёма не взяли один порт.
      const started = await launch(
        record,
        { file: 'bash', args: [path.join(profilesDir, input.profile, 'up.sh'), task] },
        {
          STATE_DIR: stateDir,
          FACTORY_STATE: stateDir,
          FACTORY_WORKSPACE_MODE: 'isolated',
          FACTORY_REQUIRE_NEW_SANDBOX: '1',
          ...(slot === null ? {} : { FACTORY_SB_K: String(slot) }),
        },
      );

      announce('sandboxes-changed', { task });

      return { task, job: toSandboxJob(started) };
    },

    async dismantle(input) {
      const task = requireTask(String(input.task));
      const [registry, record, known] = await Promise.all([
        readSandboxRegistry(stateDir),
        readSandboxJournalRecord(journalDir, task),
        profiles(),
      ]);
      const entry = registry.find((item) => item.task === task) || null;

      if (!entry) {
        throw new SandboxError('sandbox_missing', `стенда ${task} нет в реестре`, 404);
      }

      if (!ownedByTask(entry)) {
        throw new SandboxError(
          'pipeline_owned',
          'стенд принадлежит конвейеру или общему checkout — сносить его нужно из карточки задачи',
        );
      }

      if (record?.state === 'running') {
        throw new SandboxError('job_running', `по стенду ${task} уже идёт работа`);
      }

      const profile = ownerOf(record, known.filter((item) => item.canRaise).map((item) => item.id));

      if (!profile) {
        throw new SandboxError(
          'profile_unknown',
          'кокпит не знает, чей это стенд: профилей с песочницей несколько, а журнала подъёма нет',
        );
      }

      const script = path.join(profilesDir, profile, 'down.sh');

      // Машинный override сноса (COCKPIT_SANDBOX_DOWN_CMD) уважает и карточка задачи:
      // одна установка не может иметь двух разных способов снести стенд.
      if (!downCmd && !await fileExists(script)) {
        throw new SandboxError('sandbox_unsupported', `профиль ${profile} не объявил down.sh`);
      }

      const journalRecord: SandboxJournalRecord = {
        task,
        profile,
        action: 'down',
        state: 'running',
        index: 0,
        total: 0,
        label: 'снос стенда',
        message: '',
        pid: null,
        starttime: null,
        cmdline: null,
        log: path.join(journalDir, `t${task}.down.log`),
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      const command = downCmd
        ? { file: 'sh', args: ['-c', downCmd.replaceAll('{task}', task)] }
        : { file: 'bash', args: [script, task] };
      // По умолчанию незакоммиченное в worktree сохраняется: ручную песочницу человек
      // ведёт сам, и его работа не должна исчезать вместе со стендом.
      const started = await launch(journalRecord, command, {
        STATE_DIR: stateDir,
        FACTORY_STATE: stateDir,
        FACTORY_DOWN_WORKTREE: input.force ? 'force' : 'keep',
      });

      announce('sandboxes-changed', { task });

      return { task, job: toSandboxJob(started) };
    },

    /**
     * Сверка после старта сервера: единственный полный обход журнала. Живые задания
     * возвращаются под наблюдение, исчезнувшие перестают вечно «идти».
     */
    async resume() {
      running.clear();

      for (const record of await readSandboxJournal(journalDir)) {
        if (record.state === 'running') {
          running.set(record.task, record);
        }
      }

      await refresh();
      watch();
    },

    stop() {
      if (sweep) {
        clearInterval(sweep);
        sweep = null;
      }

      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
