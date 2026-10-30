// Жизненный цикл ручной песочницы: подъём, слежение за прогрессом и снос.
//
// ГРАНИЦА. Стенд поднимает и сносит СКРИПТ ПРОФИЛЯ (up.sh/down.sh) — GrigDesk не знает
// ни про контейнеры, ни про схемы. Его дело: выдать слот тем же распределителем, что
// и перед запуском конвейера, снять fail-closed гард подъёма, запомнить запуск в
// журнале и довести до человека прогресс и отказ.
//
// ПОЧЕМУ ГАРД СНИМАЕТ GrigDesk. `up.sh` без `FACTORY_WORKSPACE_MODE=isolated` и
// `FACTORY_REQUIRE_NEW_SANDBOX=1` отказывается подниматься: занять слот на четверть
// часа не должен ни агент, ни случайный вызов. Раздел «Песочницы» — второе место,
// где это решение принимает ЧЕЛОВЕК: его ручки закрыты сессией.
//
// ЧУЖОЕ НЕ ТРОГАЕМ. Стенд с реестром конвейера (t<номер>.pipeline) принадлежит попытке
// движка, стенд общего checkout (WORKSPACE_MODE=shared) — вообще не наш: у обоих свой
// владелец и свой жизненный цикл. Здесь такие стенды только показываются.
//
// ДЕЙСТВИЯ ПРОФИЛЯ. Прогон на поднятом стенде (`profiles/<профиль>/actions.json`) —
// не lifecycle: он не трогает контейнеры и схемы, поэтому доступен и стенду конвейера,
// пока тот стоит на воротах. Идёт под shared-арендой стенда, как показ «Презентаций»:
// снос дождётся конца прогона, а прогон не помешает второму прогону.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { readLaunchLog } from '../factoryRouteCli.ts';
import { listFactoryProfiles, PROFILE_RE } from '../profiles.ts';
import { readProfileServiceHost } from '../profileServiceHost.ts';
import { releaseSlot, reservedTasks, reserveSlot } from '../sandboxSlots.ts';
import { readProcessIdentity } from '../speech/modelJobsProcess.ts';
import {
  SANDBOX_ACTION_ID_RE,
  SANDBOX_TASK_RE,
  toSandboxJob,
} from '../../../../shared/plugins/sandboxes/sandboxContracts.ts';
import type {
  SandboxActionResponse,
  SandboxEntry,
  SandboxJobLog,
  SandboxJournalRecord,
  SandboxOverview,
  SandboxProfile,
} from '../../../../shared/plugins/sandboxes/sandboxContracts.ts';
import {
  fileExists,
  hasPipelineRegistry,
  readPipelineHold,
  readSandboxJournal,
  readSandboxJournalRecord,
  readSandboxRegistry,
  readSandboxStage,
  writeSandboxJournalRecord,
} from './registry.ts';
import type { SandboxRegistryEntry } from './registry.ts';
import {
  readProfileActions,
  SandboxActionsManifestError,
  toActionDecl,
  validateActionArgs,
} from './actions.ts';
import type { SandboxProfileAction } from './actions.ts';
import {
  createSandboxActivityGuard,
  SandboxActivityError,
} from './activityGuard.ts';
import type {
  SandboxActivityGuard,
  SandboxActivityLease,
} from './activityGuard.ts';

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
  sandboxActivityGuard?: SandboxActivityGuard;
  // Архивный проект новых стендов не поднимает: спрашиваем об этом раздел «Проекты»,
  // а не читаем реестр сами — архивность там одна на всех потребителей.
  isProjectDeleted?: (id: string) => boolean;
  deletedProjectIds?: () => Set<string>;
  isProjectArchived?: (id: string) => boolean;
  // Журнал сервера: кривой манифест действий профиля — предупреждение, а не отказ.
  log?: { warn: (fields: Record<string, unknown>, message: string) => void };
}

export interface SandboxRaiseInput {
  profile: string;
  task: string | null;
}

export interface SandboxDismantleInput {
  task: string;
  force?: boolean;
  profile?: string;
}

export interface SandboxRunInput {
  task: string;
  action: string;
  args?: unknown;
}

export interface SandboxService {
  overview(): Promise<SandboxOverview>;
  raise(input: SandboxRaiseInput): Promise<SandboxActionResponse>;
  dismantle(input: SandboxDismantleInput): Promise<SandboxActionResponse>;
  run(input: SandboxRunInput): Promise<SandboxActionResponse>;
  jobLog(task: string): Promise<SandboxJobLog>;
  resume(): Promise<void>;
  stop(): void;
}

const DEFAULT_SWEEP_MS = 15000;
const PROBE_TIMEOUT_MS = 250;
const MESSAGE_LIMIT = 600;
// Хвост вывода задания, который уезжает карточке по запросу: полный журнал прогона
// бывает мегабайтами, а человеку нужны последние шаги и итог.
const JOB_LOG_LIMIT = 64 * 1024;
// Сколько хвоста читать ради последней строки прогона — шага, который идёт сейчас.
const STEP_TAIL_BYTES = 400;
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
 * вопрос (`profile_stand_alive`) GrigDesk недоступен без запуска bash профиля.
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
 * Шаг прогона — последняя непустая строка его вывода. Своего журнала этапов у
 * действия профиля нет: скрипт просто печатает, что делает, и карточка показывает
 * последнюю строку как текущий шаг.
 */
async function readRunStep(log: string): Promise<string> {
  const tail = await readLaunchLog(log, STEP_TAIL_BYTES);
  const lines = tail.split('\n').map((line) => line.trim()).filter(Boolean);

  return (lines[lines.length - 1] || '').slice(0, MESSAGE_LIMIT);
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
    log = null,
    isProjectArchived = null,
    isProjectDeleted = null,
    deletedProjectIds = null,
  } = options;

  // Живые задания держатся в памяти: тик слежения обязан стоить одно чтение журнала
  // этапов на задание, а не обход всего журнала установки.
  const running = new Map<string, SandboxJournalRecord>();
  const activityGuard = options.sandboxActivityGuard
    ?? createSandboxActivityGuard({ stateDir });
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
      // Архивный профиль из списка не исчезает: его уже поднятый стенд надо сносить,
      // а снос ищет владельца именно здесь. Запрещён только подъём нового.
      const archived = isProjectArchived?.(id) === true;

      let deleted = false;

      try {
        deleted = deletedProjectIds ? deletedProjectIds().has(id) : isProjectDeleted?.(id) === true;
      } catch {
        // Инвентарь нужен для доступа к существующим стендам даже при битых настройках.
      }

      if (deleted) {
        return {
          id,
          canRaise: false,
          canDismantle: false,
          reason: 'регистрация проекта удалена',
        };
      }

      if (archived) {
        return {
          id,
          canRaise: false,
          canDismantle: down,
          reason: 'проект в архиве: новый стенд не поднимается',
        };
      }

      return {
        id,
        canRaise: missing.length === 0,
        canDismantle: down,
        reason: missing.length === 0 ? null : `профиль не объявил ${missing.join(' и ')}`,
      };
    }));
  }

  async function requireProfile(profile: string): Promise<void> {
    if (!PROFILE_RE.test(String(profile || ''))) {
      throw new SandboxError('bad_profile', 'имя профиля имеет недопустимую форму', 400);
    }

    if (isProjectDeleted?.(profile)) {
      throw new SandboxError('tombstoned', 'Регистрация проекта удалена.', 409);
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
   * стенд, поднятый мимо GrigDesk, опознаётся только когда песочницу на машине
   * умеет ровно один профиль. При неоднозначности человек выбирает профиль
   * в карточке, а dismantle проверяет его перед запуском down.sh.
   */
  function ownerOf(record: SandboxJournalRecord | null, capable: string[]): string | null {
    if (record?.profile) {
      return record.profile;
    }

    return capable.length === 1 ? capable[0] ?? null : null;
  }

  /**
   * Профиль считается привязанным к ТЕКУЩЕМУ поколению стенда, только если env
   * появился во время успешного up, запущенного самим GrigDesk. Старый journal с
   * тем же номером задачи не получает полномочия над пересозданной песочницей.
   */
  function profileBinding(
    entry: SandboxRegistryEntry,
    record: SandboxJournalRecord | null,
  ): 'verified' | 'inferred' | null {
    if (!record?.profile) {
      return null;
    }

    if (
      record.action !== 'up'
      || record.state !== 'done'
      || !record.finishedAt
      || !entry.updatedAt
    ) {
      return 'inferred';
    }

    const startedAt = Date.parse(record.startedAt);
    const finishedAt = Date.parse(record.finishedAt);
    const updatedAt = Date.parse(entry.updatedAt);
    const correlated = [startedAt, finishedAt, updatedAt].every(Number.isFinite)
      && startedAt <= updatedAt
      && updatedAt <= finishedAt;

    return correlated ? 'verified' : 'inferred';
  }

  function requireTask(task: string): string {
    if (!SANDBOX_TASK_RE.test(task)) {
      throw new SandboxError('bad_task', 'номер стенда должен быть целым числом', 400);
    }

    return task;
  }

  /** Преобразует отказ общего kernel guard в язык lifecycle песочницы. */
  async function acquireLifecycle(task: string): Promise<SandboxActivityLease> {
    try {
      return await activityGuard.acquireLifecycle(task);
    } catch (error) {
      if (error instanceof SandboxActivityError && error.code === 'SANDBOX_ACTIVITY_BUSY') {
        throw new SandboxError(
          'sandbox_busy',
          `стенд ${task} сейчас используется презентацией или другим заданием`,
        );
      }

      const reason = error instanceof Error ? error.message : 'kernel lock недоступен';

      throw new SandboxError('sandbox_guard_unavailable', reason, 503);
    }
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
    lease: SandboxActivityLease,
  ): Promise<SandboxJournalRecord> {
    await fs.mkdir(journalDir, { recursive: true });

    const log = await fs.open(record.log, 'a');
    await lease.assertPathIdentity();
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: ['ignore', log.fd, log.fd, lease.inheritedFd()],
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

    // Прогон профиля не снимает слот и не читает журнал этапов: его итог — код выхода
    // скрипта и хвост вывода, где скрипт печатает сверку или причину отказа.
    if (record.action === 'run') {
      await save({
        ...record,
        state: failed ? 'failed' : 'done',
        label: failed ? 'прогон завершился с ошибкой' : 'прогон выполнен',
        message: output || (failed ? 'процесс завершился с ошибкой' : ''),
        finishedAt: new Date().toISOString(),
      });
      announce('sandboxes-changed', { task });

      return;
    }

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

      if (record.action === 'run') {
        const step = await readRunStep(record.log);

        if (step && step !== record.label) {
          await save({ ...record, label: step });
        }

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

  /**
   * Действия профиля: манифест перечитывается на каждый обзор — он лежит рядом с
   * кодом профиля и меняется вместе с ним. Кривой манифест не закрывает раздел:
   * стенд получает пустой список, а причина уходит в журнал сервера.
   */
  async function actionsOf(profile: string | null): Promise<SandboxProfileAction[]> {
    if (!profile) {
      return [];
    }

    try {
      return await readProfileActions(profilesDir, profile);
    } catch (error) {
      if (error instanceof SandboxActionsManifestError) {
        log?.warn({ profile, reason: error.message }, 'манифест действий профиля отброшен');

        return [];
      }

      throw error;
    }
  }

  /**
   * Чей это стенд, когда он принадлежит конвейеру: профиль называет реестр попытки.
   * Своего журнала подъёма у такого стенда нет — его поднимал движок, — а действия
   * профиля нужны и ему: на воротах приёмки человек гоняет стенд руками.
   */
  async function pipelineProfile(entry: SandboxRegistryEntry): Promise<string | null> {
    if (!entry.pipeline) {
      return null;
    }

    const hold = await readPipelineHold(stateDir, entry.task);
    const profile = hold?.profile ?? '';

    return PROFILE_RE.test(profile) ? profile : null;
  }

  /** Стенд как его видит человек: реестр + владелец + живость портов. */
  async function describe(
    entry: SandboxRegistryEntry,
    journal: Map<string, SandboxJournalRecord>,
    capable: string[],
  ): Promise<SandboxEntry> {
    const record = journal.get(entry.task) || null;
    const [apiAlive, feAlive, pipelineOwner] = await Promise.all([
      entry.apiPort ? probe(entry.apiPort) : Promise.resolve(null),
      entry.fePort ? probe(entry.fePort) : Promise.resolve(null),
      pipelineProfile(entry),
    ]);
    const portsAlive = [apiAlive, feAlive].filter((alive) => alive !== null);
    const alive = portsAlive.length ? portsAlive.some(Boolean) : null;
    const owned = ownedByTask(entry);
    const profile = owned ? ownerOf(record, capable) : record?.profile ?? pipelineOwner;
    const binding = profile
      ? profileBinding(entry, record) ?? 'inferred'
      : null;
    const actions = (await actionsOf(profile)).map(toActionDecl);
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
      serviceHost: profile ? await readProfileServiceHost(profilesDir, profile) : null,
      repos: entry.repos,
      standAlive: alive,
      feAlive,
      profileBinding: binding,
      removable: reason === null,
      removableReason: reason,
      updatedAt: entry.updatedAt,
      actions,
    };
  }

  /**
   * Профиль стенда для запуска действия: у ручного — владелец по журналу, у стенда
   * конвейера — реестр попытки. Без профиля действий нет: GrigDesk не гадает, чьи
   * скрипты запускать.
   */
  async function profileForRun(
    entry: SandboxRegistryEntry,
    record: SandboxJournalRecord | null,
    capable: string[],
  ): Promise<string | null> {
    if (ownedByTask(entry)) {
      return ownerOf(record, capable);
    }

    return record?.profile ?? await pipelineProfile(entry);
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

      const [initialRegistry, initialJournal] = await Promise.all([
        readSandboxRegistry(stateDir),
        readSandboxJournal(journalDir),
      ]);
      const task = input.task === null
        ? freeManualTask(initialRegistry, initialJournal)
        : requireTask(String(input.task));
      const lease = await acquireLifecycle(task);

      try {
        // Первый снимок нужен только для выбора свободного номера. После
        // exclusive-lock всё перечитывается: параллельный процесс мог занять
        // выбранную задачу между обходом диапазона и арендой.
        const [registry, journal] = await Promise.all([
          readSandboxRegistry(stateDir),
          readSandboxJournal(journalDir),
        ]);
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
          actionId: null,
          actionLabel: null,
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
          lease,
        );

        announce('sandboxes-changed', { task });

        return { task, job: toSandboxJob(started) };
      } finally {
        // Успешный child получил копию того же OFD и продолжит держать lock сам.
        await lease.release();
      }
    },

    /**
     * Явный профиль разрешает снос ручного стенда без журнала подъёма.
     * Проверки владения и аренда действуют до запуска любого профильного скрипта.
     */
    async dismantle(input) {
      const task = requireTask(String(input.task));

      if (input.profile !== undefined && !PROFILE_RE.test(input.profile)) {
        throw new SandboxError('bad_profile', 'имя профиля имеет недопустимую форму', 400);
      }

      const lease = await acquireLifecycle(task);

      try {
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

        const capable = known.filter((item) => item.canRaise).map((item) => item.id);
        const owner = ownerOf(record, capable);
        const profile = input.profile ?? owner;

        if (input.profile !== undefined) {
          const selected = known.find((item) => item.id === input.profile);

          if (!selected) {
            throw new SandboxError('profile_unknown', `профиль ${input.profile} не найден`, 404);
          }

          if (!selected.canDismantle) {
            throw new SandboxError('sandbox_unsupported', `профиль ${input.profile} недоступен для сноса`);
          }

          if (owner && owner !== profile) {
            throw new SandboxError('profile_mismatch', 'профиль стенда изменился — обновите карточку');
          }
        }

        if (!profile) {
          throw new SandboxError(
            'profile_unknown',
            'GrigDesk не знает, чей это стенд: выберите профиль для сноса в карточке стенда',
          );
        }

        const script = path.join(profilesDir, profile, 'down.sh');

        // Машинный override сноса (GRIGDESK_SANDBOX_DOWN_CMD) уважает и карточка задачи:
        // одна установка не может иметь двух разных способов снести стенд.
        if (!downCmd && !await fileExists(script)) {
          throw new SandboxError('sandbox_unsupported', `профиль ${profile} не объявил down.sh`);
        }

        const journalRecord: SandboxJournalRecord = {
          task,
          profile,
          action: 'down',
          actionId: null,
          actionLabel: null,
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
        }, lease);

        announce('sandboxes-changed', { task });

        return { task, job: toSandboxJob(started) };
      } finally {
        await lease.release();
      }
    },

    async run(input) {
      const task = requireTask(String(input.task));
      const actionId = String(input.action || '');

      if (!SANDBOX_ACTION_ID_RE.test(actionId)) {
        throw new SandboxError('bad_action', 'идентификатор действия имеет недопустимую форму', 400);
      }

      let lease: SandboxActivityLease;

      try {
        lease = await activityGuard.acquireAction(task);
      } catch (error) {
        if (error instanceof SandboxActivityError && error.code === 'SANDBOX_ACTIVITY_BUSY') {
          throw new SandboxError('sandbox_busy', `стенд ${task} сейчас поднимается или сносится`);
        }

        const reason = error instanceof Error ? error.message : 'kernel lock недоступен';

        throw new SandboxError('sandbox_guard_unavailable', reason, 503);
      }

      try {
        const [registry, record, known] = await Promise.all([
          readSandboxRegistry(stateDir),
          readSandboxJournalRecord(journalDir, task),
          profiles(),
        ]);
        const entry = registry.find((item) => item.task === task) || null;

        if (!entry) {
          throw new SandboxError('sandbox_missing', `стенда ${task} нет в реестре`, 404);
        }

        if (record?.state === 'running') {
          throw new SandboxError('job_running', `по стенду ${task} уже идёт работа`);
        }

        const capable = known.filter((item) => item.canRaise).map((item) => item.id);
        const profile = await profileForRun(entry, record, capable);

        if (!profile) {
          throw new SandboxError(
            'profile_unknown',
            'GrigDesk не знает, чей это стенд, и не запускает чужие скрипты наугад',
          );
        }

        const action = (await actionsOf(profile)).find((item) => item.id === actionId) || null;

        if (!action) {
          throw new SandboxError('action_unknown', `профиль ${profile} не объявил действие ${actionId}`, 404);
        }

        if (!await fileExists(action.script)) {
          throw new SandboxError('action_unavailable', `скрипт действия ${actionId} не найден`);
        }

        const checked = validateActionArgs(action.args, input.args);

        if (checked.error) {
          throw new SandboxError('bad_args', checked.error, 400);
        }

        const journalRecord: SandboxJournalRecord = {
          task,
          profile,
          action: 'run',
          actionId: action.id,
          actionLabel: action.label,
          state: 'running',
          index: 0,
          total: 0,
          label: 'запуск прогона',
          message: '',
          pid: null,
          starttime: null,
          cmdline: null,
          log: path.join(journalDir, `t${task}.run-${action.id}.log`),
          startedAt: new Date().toISOString(),
          finishedAt: null,
        };
        // Прежний вывод того же действия не нужен: журнал открывается заново, иначе
        // хвост старого прогона выдавался бы за шаг нового.
        await fs.rm(journalRecord.log, { force: true });

        // Аргументы уходят argv в порядке объявления — скрипту не нужен разбор JSON,
        // а GrigDesk — знание о том, что они значат.
        const started = await launch(
          journalRecord,
          { file: 'bash', args: [action.script, task, ...checked.argv] },
          {
            STATE_DIR: stateDir,
            FACTORY_STATE: stateDir,
          },
          lease,
        );

        announce('sandboxes-changed', { task });

        return { task, job: toSandboxJob(started) };
      } finally {
        await lease.release();
      }
    },

    /**
     * Хвост вывода текущего задания стенда. Итог в карточке ограничен парой строк, а
     * прогон печатает сверку по шагам — её человек читает целиком, но не мегабайтами.
     */
    async jobLog(input) {
      const task = requireTask(String(input));
      const record = running.get(task) || await readSandboxJournalRecord(journalDir, task);

      if (!record) {
        throw new SandboxError('job_missing', `по стенду ${task} заданий GrigDesk не было`, 404);
      }

      let text = '';

      try {
        text = await fs.readFile(record.log, 'utf8');
      } catch {
        text = '';
      }

      const truncated = text.length > JOB_LOG_LIMIT;

      return {
        task,
        action: record.action,
        state: record.state,
        text: truncated ? text.slice(-JOB_LOG_LIMIT) : text,
        truncated,
      };
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
