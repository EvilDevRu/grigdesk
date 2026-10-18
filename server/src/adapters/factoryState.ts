// FactoryStateAdapter — единственная точка чтения состояния фабрики.
// Изолирует хрупкий файловый источник (`~/.factory/state`) от остального сервера:
// читает `tNNNN.pipeline` (реестр), `logs/tNNNN.stages.log` (таймлайн), проверяет
// живость демона по `/proc/<ORCH_PID>`. Только ЧТЕНИЕ — мутации идут через factory-cli.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parsePipeline } from '../lib/pipelineParse.ts';
import { parseStagesLog } from '../lib/stagesParse.ts';
import { bootstrapStall, detectStall } from '../lib/stall.ts';
import { enrichRunnerStall } from '../lib/runnerStall.ts';
import { readRunSilence } from '../lib/factoryCli.ts';
import { loadGraph, graphForRoute, computeNodeStatuses, parseLoops } from '../lib/factoryGraph.ts';
import { buildRouteDef, routeStageKeys } from '../lib/routeGraph.ts';
import { readLoopProgress } from '../lib/factoryLoopProgress.ts';
import { RoutesStore } from '../modules/routes/store.ts';
import { parseSandboxRepositories } from '../lib/sandboxEnv.ts';
import { routeInstrumentationMode } from '../lib/factoryLaunchContract.ts';
import { bootstrapNodeVerdict, readNodeVerdicts, stopVerdictOf } from '../lib/factoryNodeVerdicts.ts';
import { stallIsArbitrable } from '../lib/factoryArbiter.ts';
import {
  readFactoryAttemptLedger,
  verifyFactoryAttemptEnvironment,
} from '../lib/factoryAttemptLedger.ts';
import {
  activeRunnerReason,
  loadRunnerConfig,
  readRunnerAttempts,
  readRunnerWorkTime,
  resolveRunnerState,
} from '../lib/runnerState.ts';
import type { ProfileGraphDef, LoopFacts } from '../lib/factoryGraph.ts';
import type { RouteGraphDef } from '../lib/routeGraph.ts';
import type { StallInfo, StallEvent } from '../lib/stall.ts';
import type { ArbiterCardsStore } from '../lib/arbiterCards.ts';

// Реестр задачи — плоская провайдерская проекция `tNNNN.pipeline`.
type Registry = Record<string, string>;

// Доверенный журнал попытки: единственный источник executable identity.
type TrustedAttempt = Awaited<ReturnType<typeof readFactoryAttemptLedger>>;

// Форма схемы задачи. Узлы, чей провал ведёт маршрут вперёд, есть только у
// закреплённого бандла — у legacy-графа профиля их нет вовсе.
type TaskGraphDef = (RouteGraphDef | ProfileGraphDef) & {
  forwardOnFailure?: readonly string[];
};

// Проекция чистой работы попытки: сумма и её источник.
interface WorkTimeLedger {
  workSec: number;
  gateWaitSec: number;
  lastEventSec: number;
  runningSinceMs?: number | null;
  source?: string;
  approximate?: boolean;
}

// Этапы конвейера по маршрутам (порядок ключей реестра). Держим здесь, чтобы
// собирать статус-карту предсказуемо; форма графа (координаты) придёт из
// profiles/<profile>/graph.json на этапе модуля «Конвейер».
// DEMO-ключей здесь нет: съёмка удалена из цепочки и живёт в отдельном сервисе. Пока DEMO
// числился этапом маршрута, прогресс feature не доходил до 100%, а дошедшая до ретро
// задача выглядела недоделанной.
const ROUTE_STAGES: Record<string, string[]> = {
  feature: ['SCOUT', 'PLAN', 'SKEPTIC', 'VALIDATE', 'TRANSLATOR', 'GATE_PLAN', 'TESTS',
    'TCRITIC', 'BUILD', 'SIMPLIFY', 'REVIEW', 'TRACE', 'PHPCHECK', 'LINT', 'BROWSER',
    'GATE_ACCEPT', 'SHIP', 'RETRO'],
  debug: ['SCOUT', 'REPRO', 'INSTRUMENT', 'DIAGNOSE', 'HYPOSKEPTIC', 'PROOF', 'TRANSLATOR',
    'GATE_CAUSE', 'TESTS', 'BUILD', 'REVIEW', 'MEASURE', 'PHPCHECK', 'LINT',
    'GATE_ACCEPT', 'SHIP', 'RETRO'],
  trivial: ['SCOUT', 'BUILD', 'REVIEW', 'PHPCHECK', 'LINT', 'GATE_ACCEPT', 'SHIP', 'RETRO'],
};

// Находим визуальный узел, соответствующий остановившемуся движковому этапу.
// runnerKeys важны для составных этапов: один PLAN может обслуживать несколько
// узлов схемы. В таком случае сначала берём реально активный узел.
function stallNodeId(
  def: TaskGraphDef,
  statuses: Record<string, string>,
  stage: string | null | undefined,
) {
  if (!stage) return null;
  const candidates = Object.keys(def.pos).filter((nid) => [
    def.keys[nid],
    def.runnerKeys[nid],
    nid.toUpperCase(),
  ].includes(stage));
  return candidates.find((nid) => ['run', 'wait', 'premature', 'stall'].includes(String(statuses[nid])))
    || candidates.find((nid) => def.keys[nid] === stage)
    || candidates[0]
    || null;
}

// Кто отдаёт чистую работу старой попытки: read-only `factory work-time`.
type WorkTimeReader = (identity: {
  task: string;
  profile: string;
  attempt: string;
}) => Promise<{ workSec?: unknown; gateWaitSec?: unknown; lastEventSec?: unknown } | null>;

export interface FactoryStateAdapterOptions {
  stateDir: string;
  profilesDir: string;
  routesDir?: string | null;
  controlDir?: string | null;
  workTimeReader?: WorkTimeReader | null;
  arbiterCards?: ArbiterCardsStore | null;
}

export class FactoryStateAdapter {
  readonly stateDir: string;

  readonly profilesDir: string;

  readonly routesDir: string | null;

  readonly controlDir: string | null;

  // Разбор арбитра последней остановки. Только чтение: пишет его модуль factory после
  // хода, а карточка задачи и модалка узла обязаны его видеть, а не терять.
  readonly arbiterCards: ArbiterCardsStore | null;

  readonly workTimeReader: WorkTimeReader | null;

  private readonly _workTimeCache = new Map<string, {
    key: string;
    promise: Promise<WorkTimeLedger | null>;
  }>();

  private _routesStore: RoutesStore | null = null;

  // Задачи, которым сервер прямо сейчас передаёт ход, и сколько таких передач идёт.
  // Реестр в памяти намеренно: передачу ведёт HTTP-запрос этого процесса, и после
  // рестарта отметка обязана исчезнуть вместе с ним, а не висеть фантомом.
  private readonly _handoffs = new Map<string, number>();

  constructor({
    stateDir, profilesDir, routesDir = null, controlDir = null, workTimeReader = null,
    arbiterCards = null,
  }: FactoryStateAdapterOptions) {
    this.stateDir = stateDir;
    this.profilesDir = profilesDir;
    this.routesDir = routesDir;
    this.controlDir = controlDir;
    this.arbiterCards = arbiterCards;
    this.workTimeReader = workTimeReader;
  }

  /** Только синтаксис UI-проекции; разрешением на исполнение эта проверка не является. */
  hasRouteProjectionIdentity(registry: Registry | null | undefined) {
    return Boolean(registry
      && registry.CATALOG_PROTOCOL === 'route-v2'
      && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(registry.PROFILE || '')
      && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(registry.ROUTE || '')
      && /^a_[a-f0-9]{32}$/.test(registry.ATTEMPT_ID || '')
      && /^[a-f0-9]{64}$/.test(registry.ROUTE_HASH || ''));
  }

  /**
   * Единственный источник executable identity — trusted engine control ledger.
   * `.pipeline` здесь лишь сверяемая provider-writable проекция.
   */
  async readTrustedAttempt(task: string | number, registry: Registry | null = null) {
    const projection = registry || (await this.readRegistry(task)).registry;
    return readFactoryAttemptLedger({
      controlDir: this.controlDir ?? undefined,
      stateDir: this.stateDir,
      task: String(task),
      registry: projection,
    });
  }

  /** Перед destructive lifecycle mutable `.env` обязан точно совпасть с pin профиля. */
  verifyTrustedEnvironment(
    trusted: Parameters<typeof verifyFactoryAttemptEnvironment>[0],
    env: Parameters<typeof verifyFactoryAttemptEnvironment>[1],
  ) {
    return verifyFactoryAttemptEnvironment(trusted, env);
  }

  /**
   * Форма графа текущей задачи — только из ЗАКРЕПЛЁННОГО бандла. Потерянный или
   * подменённый pin является ошибкой целостности, а не поводом открыть legacy graph.
   */
  async routeDef(registry: Registry, opts: { workspaceMode?: string } = {}): Promise<RouteGraphDef> {
    if (!this.hasRouteProjectionIdentity(registry) || !this.routesDir) {
      throw new Error('реестр не содержит полностью закреплённую route-attempt identity');
    }
    try {
      const store = (this._routesStore ||= new RoutesStore({ baseDir: this.routesDir }));
      const { route } = await store.readRoute(
        String(registry.PROFILE),
        String(registry.ROUTE),
        String(registry.ROUTE_HASH),
      );
      let bootstrap: Parameters<typeof buildRouteDef>[0] | undefined;
      if (/^[a-f0-9]{64}$/.test(registry.CATALOG_HASH || '')) {
        const catalog = await store.readCatalog(String(registry.PROFILE),
          String(registry.CATALOG_HASH));
        if (catalog.catalog.routes[String(registry.ROUTE)] !== registry.ROUTE_HASH) {
          throw new Error('routeHash не входит в закреплённый catalogHash');
        }
        bootstrap = catalog.bootstrap as Parameters<typeof buildRouteDef>[0];
      }
      // Поля машины в route.json верхнеуровневые (sequence/nodes/entry). Хранилище
      // отдаёт проверенный документ бандла, а машина маршрута объявляет те же поля
      // строже — приведение одно и ровно на границе чтения.
      return buildRouteDef(
        {
          entry: route.entry,
          bootstrap: route.bootstrap,
          loop: route.loop,
          sequence: route.sequence,
          nodes: route.nodes,
        } as Parameters<typeof buildRouteDef>[0],
        String(registry.ROUTE),
        { ...opts, bootstrap },
      );
    } catch (err) {
      throw new Error(`закреплённый маршрут недоступен или повреждён: ${(err as Error).message}`);
    }
  }

  /**
   * Маршруты ОПУБЛИКОВАННОГО каталога профиля — то, из чего человек выбирает при
   * запуске. Список берём из бандла, а не из `graph.json` профиля: стартовать можно
   * только по опубликованному маршруту, и предложить неопубликованный значит
   * пообещать то, чего движок не примет.
   * null — каталог не опубликован
   */
  async catalog(profile: string | null | undefined) {
    if (!this.routesDir || !profile) return null;
    try {
      const store = (this._routesStore ||= new RoutesStore({ baseDir: this.routesDir }));
      const current = await store.readCurrent(profile);
      if (!current) return null;
      const routes = Object.keys(current.catalog.routes || {}).sort();
      const entries = await Promise.all(routes.map(async (routeId) => {
        const { route } = await store.readRoute(
          profile,
          routeId,
          String(current.catalog.routes[routeId]),
        );
        const instrumentationMode = routeInstrumentationMode(route);
        return [routeId, {
          deliveryMode: route.nodes.some((node) => node.id === 'ship') ? 'publish' : 'disabled',
          instrumentationMode,
          instrumentationRequired: instrumentationMode === 'explicit',
          // Подпись из бандла: её читают человек в форме запуска и триаж в промпте.
          // Своего словаря названий у GrigDesk нет — маршруты именует профиль.
          title: typeof route.title === 'string' ? route.title : '',
        }];
      }));
      return {
        catalogHash: current.catalogHash,
        routes,
        routeOptions: Object.fromEntries(entries),
      };
    } catch {
      return null; // каталога нет или он испорчен — запуск обязан fail closed
    }
  }

  /**
   * Единственный runtime root. Legacy-файлы могут оставаться в нём для истории,
   * но без совпавшего trusted ledger ни одна мутация их не принимает.
   */
  async taskStateDir(_task: string | number) {
    return this.stateDir;
  }

  /** Только такие задачи разрешено передавать единственному движку для mutation/resume. */
  async isExecutableTask(task: string | number) {
    try { await this.readTrustedAttempt(task); return true; }
    catch { return false; }
  }

  /**
   * Проверка живости демона оркестратора: pid жив И его cmdline содержит
   * `bin/factory` и номер задачи отдельным аргументом (эталон — daemon_state
   * в dashboard.py). Синхронно и дёшево.
   */
  isDaemonAlive(orchPid: unknown, task: string | number) {
    const pid = Number(orchPid);
    if (!pid || Number.isNaN(pid)) return false;
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
      const argv = raw.toString('utf8').split('\0').filter(Boolean);
      const hasBin = argv.some((a) => a.endsWith('/bin/factory') || a === 'bin/factory');
      const hasTask = argv.includes(String(task));
      return hasBin && hasTask;
    } catch {
      return false; // нет /proc/<pid> → мёртв
    }
  }

  /**
   * Отметить передачу хода: сервер записывает решение (ворота, возврат курсора) и сразу
   * поднимает продолжение. Демона между ними нет по устройству: `gate --commit-only` уже
   * вышел и снял ORCH_PID, а resume берёт его только после подготовки — секунды и
   * десятки секунд. Без отметки сводка видела «демона нет, а маршрут не закрыт» и звонила
   * «Конвейер оборвался» сразу после «Принять». Снять отметку вызывающий обязан в `finally`.
   */
  beginHandoff(task: string | number): () => void {
    const key = String(task);

    this._handoffs.set(key, (this._handoffs.get(key) || 0) + 1);

    let done = false;

    return () => {
      if (done) {
        return;
      }

      done = true;

      const left = (this._handoffs.get(key) || 1) - 1;

      if (left > 0) {
        this._handoffs.set(key, left);
      } else {
        this._handoffs.delete(key);
      }
    };
  }

  /**
   * Живость прогона для витрины — сводки, графа и вотчеров: демон работает или сервер
   * прямо сейчас поднимает продолжение. Подтверждение подъёма и отказы мутаций смотрят
   * только isDaemonAlive: иначе resume «подтвердил» бы сам себя собственной отметкой.
   */
  isRunLive(orchPid: unknown, task: string | number) {
    return this.isDaemonAlive(orchPid, task) || this._handoffs.has(String(task));
  }

  /** Список номеров задач из единственного runtime root. */
  async listTaskIds(): Promise<string[]> {
    const ids = new Set<string>();
    let files: string[] = [];
    try { files = await fsp.readdir(this.stateDir); } catch { return []; }
    for (const f of files) {
      const m = /^t(\d+)\.pipeline$/.exec(f);
      if (m?.[1]) ids.add(m[1]);
    }
    // Стабильный числовой порядок (как в dashboard.collect_sandboxes).
    return [...ids].sort((a, b) => (a.length - b.length) || a.localeCompare(b));
  }

  /** Параметры песочницы задачи (tNNNN.env): порты, worktree-пути. */
  async readEnv(task: string | number): Promise<Registry> {
    try {
      const dir = await this.taskStateDir(task);
      return parsePipeline(await fsp.readFile(path.join(dir, `t${task}.env`), 'utf8'));
    } catch { return {}; }
  }

  /**
   * Прогресс СБОРКИ песочницы (tNNNN.stage): строки «время|шаг/всего|подпись»,
   * актуальна последняя. Пока стенд строится, порты в env ещё не появились —
   * это единственный источник «что сейчас происходит со стендом».
   */
  async readSandboxStage(task: string | number) {
    try {
      const p = path.join(await this.taskStateDir(task), `t${task}.stage`);
      const lines = (await fsp.readFile(p, 'utf8')).trim().split('\n').filter(Boolean);
      const m = /^([^|]*)\|(\d+)\/(\d+)\|(.*)$/.exec(lines[lines.length - 1] || '');
      if (!m) return null;
      return { at: m[1], step: Number(m[2]), total: Number(m[3]), label: String(m[4] ?? '').trim() };
    } catch { return null; }
  }

  /** Сырой реестр одной задачи + время модификации. */
  async readRegistry(task: string | number) {
    const file = path.join(await this.taskStateDir(task), `t${task}.pipeline`);
    const [text, stat] = await Promise.all([
      fsp.readFile(file, 'utf8'),
      fsp.stat(file),
    ]);
    return { registry: parsePipeline(text), mtime: stat.mtimeMs };
  }

  /**
   * Проекция времени обычно уже лежит в реестре. Для попыток, начатых до появления
   * WORK_TIME_S, один раз на версию реестра просим read-only `factory work-time`
   * проверить исходный ledger. Так старый активный прогон получает честную цифру,
   * но сервер не дублирует у себя проверку hash-chain и классификацию узлов.
   */
  async readWorkTime(
    task: string | number,
    registry: Registry,
    trusted: TrustedAttempt | null,
    mtime: number,
    { stateDir = this.stateDir, runnerStages = [] }: {
      stateDir?: string;
      runnerStages?: string[];
    } = {},
  ): Promise<WorkTimeLedger | null> {
    const uint = (value: unknown) => {
      if (!/^(0|[1-9][0-9]*)$/.test(String(value ?? ''))) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : null;
    };
    const projectedWork = uint(registry.WORK_TIME_S);
    let ledger: WorkTimeLedger | null = null;
    if (projectedWork !== null) {
      ledger = {
        workSec: projectedWork,
        gateWaitSec: uint(registry.GATE_WAIT_S) ?? 0,
        lastEventSec: uint(registry.WORK_TIMER_SINCE) ?? 0,
      };
    } else if (trusted && typeof this.workTimeReader === 'function') {
      const cacheKey = `${trusted.attempt}:${mtime}`;
      const cached = this._workTimeCache.get(String(task));
      let promise = cached?.key === cacheKey ? cached.promise : null;
      if (!promise) {
        promise = Promise.resolve(this.workTimeReader({
          task: String(task), profile: String(trusted.profile), attempt: String(trusted.attempt),
        })).then((value) => {
          const workSec = uint(value?.workSec);
          if (workSec === null) return null;
          return {
            workSec,
            gateWaitSec: uint(value?.gateWaitSec) ?? 0,
            lastEventSec: uint(value?.lastEventSec) ?? 0,
          };
        }).catch(() => null);
        this._workTimeCache.set(String(task), { key: cacheKey, promise });
      }
      ledger = await promise;
    }

    // Старый route ledger измеряет расстояние между событиями. После остановки
    // оркестратора это расстояние включает часы/дни простоя и приписывает их
    // следующему узлу (иначе завершённый LINT может ошибочно получить лишнее время).
    // Для исполняемой v2-попытки считаем реальные процессы runner-а, ограниченные
    // createdAt trusted attempt; ledger оставляем источником ожидания ворот.
    if (trusted && this.hasRouteProjectionIdentity(registry) && runnerStages.length) {
      const activeRuns = Object.fromEntries(runnerStages.map((stage) => [
        stage,
        registry[stage] === 'running' ? registry[`ACTIVE_RUN_${stage}`] || undefined : undefined,
      ]));
      const runner = await readRunnerWorkTime(stateDir, task, runnerStages, {
        sinceMs: Date.parse(trusted.createdAt || ''),
        activeRuns,
      });
      if (runner) {
        return {
          workSec: runner.workSec,
          gateWaitSec: ledger?.gateWaitSec ?? uint(registry.GATE_WAIT_S) ?? 0,
          lastEventSec: 0,
          runningSinceMs: runner.runningSinceMs,
          source: 'runner-telemetry',
          approximate: true,
        };
      }

      const touched = runnerStages.some((stage) => ![
        '', 'idle', 'pending', 'skipped',
      ].includes(registry[stage] || ''));
      if (!touched) {
        return {
          workSec: 0,
          gateWaitSec: ledger?.gateWaitSec ?? uint(registry.GATE_WAIT_S) ?? 0,
          lastEventSec: 0,
          runningSinceMs: null,
          source: 'runner-telemetry',
          approximate: true,
        };
      }
      // Уже исполнявшийся маршрут без run-артефактов нельзя честно оценить:
      // лучше не показывать число, чем снова выдать календарный простой за работу.
      return null;
    }

    return ledger && {
      ...ledger,
      runningSinceMs: null,
      source: 'route-ledger',
      approximate: true,
    };
  }

  /** Карта статусов этапов маршрута: STAGE → { status, at, fails, dur, fanout, denials }. */
  buildStageMap(registry: Registry) {
    const route = registry.ROUTE || 'feature';
    // v2-реестр несёт РОВНО узлы закреплённого бандла (в порядке машины) —
    // никаких захардкоженных списков этапов.
    const stages = registry.CATALOG_PROTOCOL === 'route-v2'
      ? routeStageKeys(registry)
      : (ROUTE_STAGES[route] || ROUTE_STAGES.feature || []);
    const map: Record<string, Record<string, unknown>> = {};
    for (const key of stages) {
      map[key] = {
        status: registry[key] || 'idle', // отсутствие ключа = idle (не отслеживалось)
        at: registry[`${key}_AT`] || null,
        fails: registry[`${key}_FAILS`] ? Number(registry[`${key}_FAILS`]) : 0,
        dur: registry[`DUR_${key}`] ? Number(registry[`DUR_${key}`]) : null,
        fanout: registry[`FANOUT_${key}`] ? Number(registry[`FANOUT_${key}`]) : null,
        // Отказы политики прав внутри хода. Ключа нет — движок НЕ ЗНАЕТ (ход оборвался
        // до события result), и это не то же самое, что записанный ноль. Строгая
        // проверка, а не truthy: `'0'` — правдивый ноль, а мусор из реестра — не число.
        denials: /^\d+$/.test(registry[`DENIALS_${key}`] || '')
          ? Number(registry[`DENIALS_${key}`])
          : null,
      };
    }
    return { route, stages, map };
  }

  /** Таймлайн задачи из stages.log (пусто, если журнала нет). */
  async readTimeline(task: string | number): Promise<StallEvent[]> {
    try {
      const dir = await this.taskStateDir(task);
      return parseStagesLog(await fsp.readFile(path.join(dir, 'logs', `t${task}.stages.log`), 'utf8'));
    } catch { return []; }
  }

  /** Краткая карточка задачи для списка. */
  async getTaskSummary(task: string | number) {
    const { registry, mtime } = await this.readRegistry(task);
    const { route, stages, map } = this.buildStageMap(registry);
    const daemonAlive = this.isRunLive(registry.ORCH_PID, task);
    const env = await this.readEnv(task);
    const sandbox = parseSandboxRepositories(env, { allowLegacy: true });
    let trusted: TrustedAttempt | null = null;
    try { trusted = await this.readTrustedAttempt(task, registry); } catch { /* read-only */ }
    const readOnly = !trusted;
    // Причина остановки идёт В СВОДКУ, а не только в деталь задачи: затык надо видеть
    // в списке, не открывая карточку. Иначе движок ждёт человека, а в интерфейсе это
    // выглядит обычным «○ стоит», как у доделанной задачи.
    const timeline = await this.readTimeline(task);
    return {
      task,
      route,
      // Старый реестр остаётся видимым как архивная проекция, но никакая server-side
      // мутация не имеет права передать его единственному движку.
      readOnly,
      workspaceMode: trusted?.workspaceMode || sandbox.workspaceMode,
      // Попытка и её исход. Без них кнопка «Продолжить» не отличила бы упавший
      // прогон от закрытой попытки. `WF_STATUS` тут не судья: это вторичная
      // проекция активности. Терминальность несёт trusted attempt-ledger и его
      // RESULT (completed/abandoned/recovered/human-rewind).
      attempt: trusted?.attempt || registry.ATTEMPT_ID || null,
      result: trusted?.terminal || registry.RESULT || null,
      profile: trusted?.profile || registry.PROFILE || null,
      wfStatus: registry.WF_STATUS || null,
      orchPid: registry.ORCH_PID || null,
      daemonAlive,
      needsRun: registry.NEEDS_RUN === '1',
      stalledHuman: trusted?.bootstrapStop?.state === 'waiting' || registry.STALLED_HUMAN === '1',
      bootstrapStop: trusted?.terminal ? null : trusted?.bootstrapStop || null,
      stall: await this.summaryStall({ registry, timeline, daemonAlive, trusted, task }),
      // Молчание идущего хода. detectStall сюда не дотягивается по устройству: он
      // отвечает на «почему конвейер СТОИТ», а зависший агент формально работает —
      // демон жив, этап running, флага остановки нет. Порог не применяем, отдаём
      // замер: решение «это уже висяк» одно на всех и живёт в настройках.
      silence: readRunSilence({ stateDir: await this.taskStateDir(task), task, registry }),
      stages,
      stageMap: map,
      updatedAt: mtime,
    };
  }

  /**
   * Остановка для СПИСКА задач вместе с признаком «за это берётся арбитр».
   *
   * Журнал попытки читается только у остановленной задачи: список опрашивается часто, и
   * платить чтением событий за каждую живую задачу нельзя (та же грабля, что убила
   * карточку «Слоты запуска», — дорогое чтение на частом пути).
   */
  async summaryStall({ registry, timeline, daemonAlive, trusted, task }: {
    registry: Registry;
    timeline: StallEvent[];
    daemonAlive: boolean;
    trusted: TrustedAttempt | null;
    task: string | number;
  }) {
    const bootstrap = trusted?.terminal ? null : bootstrapStall(
      trusted?.bootstrapStop, registry.BOOTSTRAP_ENV_ERROR,
    );

    if (bootstrap) {
      return bootstrap;
    }

    const stall = await enrichRunnerStall({
      stateDir: this.stateDir,
      task,
      registry,
      timeline,
      attempt: trusted?.attempt,
      stall: detectStall({ registry, timeline, daemonAlive }),
    });
    if (!stall || trusted?.cursor?.state !== 'stopped') return stall;

    const verdicts = await readNodeVerdicts({
      controlDir: this.controlDir ?? undefined,
      task,
      attempt: trusted.attempt,
    });
    const stopVerdict = stopVerdictOf(verdicts, trusted.cursor.stop);
    return {
      ...stall,
      // Узел остановки нужен и в СВОДКЕ, а не только в графе: по нему автоматический
      // арбитр отличает «эту остановку я уже отдал человеку» от «маршрут встал в другом
      // месте». Полного `stallNodeId` здесь нет по цене — он требует определения схемы, —
      // но вердикт остановки уже прочитан строкой выше, и узел лежит прямо в нём.
      node: stopVerdict?.node || null,
      arbitrable: stallIsArbitrable(trusted.cursor.stop, stopVerdict, {
        loop: registry.LOOP_MODE === '1',
      }),
      arbiter: this.arbiterCards?.read(task, trusted.attempt) || null,
    };
  }

  /** Полная деталь задачи: реестр + карта этапов + таймлайн из stages.log. */
  async getTaskDetail(task: string | number) {
    const summary = await this.getTaskSummary(task);
    const { registry } = await this.readRegistry(task);
    return { ...summary, registry, timeline: await this.readTimeline(task) };
  }

  /**
   * Полный граф конвейера задачи: определение схемы (узлы/рёбра/позиции) +
   * статус каждого узла + возвраты. Всё для отрисовки SVG-графа на клиенте.
   */
  async getTaskGraph(task: string | number) {
    const stateDir = await this.taskStateDir(task);
    const { registry, mtime } = await this.readRegistry(task);
    const profile = registry.PROFILE;
    if (!profile) throw new Error(`у задачи t${task} нет PROFILE в реестре`);
    let trusted: TrustedAttempt | null = null;
    try { trusted = await this.readTrustedAttempt(task, registry); } catch { /* read-only */ }
    const executable = Boolean(trusted);
    // Порты стенда и режим workspace — в tNNNN.env (не в реестре .pipeline).
    let env: Registry = {};
    try {
      env = parsePipeline(await fsp.readFile(path.join(stateDir, `t${task}.env`), 'utf8'));
    } catch { /* env нет */ }
    let def: TaskGraphDef;
    let route = registry.ROUTE;
    if (registry.CATALOG_PROTOCOL === 'route-v2') {
      // Маркер текущего протокола запрещает fallback: pin должен пройти полностью.
      // Режим закреплён в env попытки: shared-профиль рисуется без ромба песочницы.
      def = await this.routeDef(registry, { workspaceMode: env.WORKSPACE_MODE });
    } else {
      // Исторический legacy graph доступен только для просмотра. Mutation endpoints
      // проверяют executable identity до любых команд и записей.
      const g = loadGraph(this.profilesDir, profile);
      route = registry.ROUTE || String(g.default_route);
      def = graphForRoute(g, route);
    }
    const runnerConfig = loadRunnerConfig(this.profilesDir, profile);
    const executablePos = Object.fromEntries(Object.entries(def.pos).filter(([nid]) =>
      !(def instanceof Object && 'nodeOrigins' in def
        && def.nodeOrigins[nid]?.executable === false)));
    const statuses = computeNodeStatuses({
      pf: registry, pos: executablePos, keys: def.keys, optional: def.optional, mtimeMs: mtime,
      // Узлы, чей провал ведёт маршрут вперёд, знает только закреплённый бандл;
      // у legacy-графа их нет, и поведение остаётся прежним.
      forwardOnFailure: def.forwardOnFailure || [],
      // Чем маршрут занят на самом деле, знает журнал, а не проекция: у прерванного
      // захода `running` в реестре остаётся навсегда и в одиночку читается как «повис».
      cursorNode: trusted?.cursor?.node || null,
    });
    // nodeOrigins описывает и не нарисованные узлы проекции (status, остановки):
    // статус нужен только узлам змейки, а служебный узел на ней не бывает «пройден».
    const nodeOrigins = 'nodeOrigins' in def
      ? Object.fromEntries(Object.entries(def.nodeOrigins).filter(([nid]) => nid in def.pos))
      : undefined;
    for (const [nid, origin] of Object.entries(nodeOrigins ?? {})) {
      if (!origin.executable && nid !== 'sandbox') {
        statuses[nid] = 'pending';
      }
    }
    let loops: LoopFacts = { loops: {}, halted: null, haltMsg: '' };
    try {
      const log = await fsp.readFile(path.join(stateDir, 'logs', `t${task}.stages.log`), 'utf8');
      loops = parseLoops(log);
    } catch { /* журнала нет */ }

    const parsedSandbox = parseSandboxRepositories(env, { allowLegacy: true });

    // Честный статус ромба песочницы: порты есть → готова; идёт сборка → running
    // (при живом демоне), демон умер посреди сборки → fail. Иначе — как посчитала цепочка.
    const alive = this.isRunLive(registry.ORCH_PID, task);
    // Узел под курсором журнала обязан гореть работой всё время, пока этап идёт. Реестр
    // тут не помощник: свой статус узел переписывает по завершении, а на повторном заходе
    // до тех пор несёт `done` от прошлого круга — схема показывала «нигде ничего не идёт»
    // при живом агенте. Пауза на воротах — та же история со стороны ожидания.
    const cursorNode = trusted?.cursor?.node || null;
    if (cursorNode && cursorNode in def.pos) {
      if (trusted?.cursor?.state === 'paused') statuses[cursorNode] = 'wait';
      else if (trusted?.cursor?.state === 'ready' && alive) statuses[cursorNode] = 'run';
    }
    const sandbox = env.FE_PORT ? null : await this.readSandboxStage(task);
    // Что каждый узел СКАЗАЛ, закрывая заход: класс владельца провала и типизированные
    // находки с якорями на файлы. В провайдерскую проекцию попадает только однострочный
    // дайджест `<КЛЮЧ>_COMMENT`, поэтому вопрос, ради которого маршрут встал на человеке,
    // читался лишь из `stage-results/` руками. Одно чтение на весь граф, а не на узел.
    const verdicts = trusted
      ? await readNodeVerdicts({
        controlDir: this.controlDir ?? undefined,
        task,
        attempt: trusted.attempt,
      })
      : {};

    const bootstrapNode = Object.entries(nodeOrigins || {}).find(([, origin]) => (
      origin.scope === 'bootstrap' && origin.originId === 'scout'
    ))?.[0] || null;
    const bootstrap = trusted?.terminal ? null : bootstrapStall(
      trusted?.bootstrapStop, registry.BOOTSTRAP_ENV_ERROR,
    );
    const timeline = await this.readTimeline(task);
    const detectedStall = bootstrap || await enrichRunnerStall({
      stateDir: this.stateDir,
      task,
      registry,
      timeline,
      attempt: trusted?.attempt,
      stall: detectStall({
        registry,
        timeline,
        daemonAlive: alive,
      }),
    });

    // Узел, чей вердикт объявил текущую остановку. Их в журнале может остаться
    // несколько — прежнюю остановку могли снять возвратом на соседний узел, — поэтому
    // берём событие с наибольшим номером.
    const cursorStop = trusted?.cursor?.state === 'stopped' ? trusted.cursor.stop : null;
    const stopVerdict = stopVerdictOf(verdicts, cursorStop);

    // Имя узла остановки берём у журнала, когда строка журнала его не назвала: старые
    // записи движка писали остановку без узла, и подсвечивать на схеме было нечего.
    const stallNode = (bootstrap ? bootstrapNode : null) || stallNodeId(def, statuses, detectedStall?.stage)
      || (stopVerdict && def.pos[stopVerdict.node] !== undefined ? stopVerdict.node : null);

    // Берётся ли за неё арбитр — решает ОДНО правило, общее с его собственным гейтом.
    // Кнопка, за которой стоит отказ, хуже отсутствующей кнопки: остановка `human` без
    // вердикта (исчерпанный бюджет повторов) арбитру не предлагается.
    const arbitrable = Boolean(cursorStop) && stallIsArbitrable(cursorStop, stopVerdict, {
      loop: registry.LOOP_MODE === '1',
    });

    const stall: (StallInfo & {
      node: string | null;
      arbitrable: boolean;
      arbiter: unknown;
    }) | null = detectedStall
      ? {
        ...detectedStall,
        node: stallNode,
        arbitrable: bootstrap ? false : arbitrable,
        // Человеческая формулировка того же затыка, если арбитр его уже разбирал.
        arbiter: this.arbiterCards?.read(task, trusted?.attempt) || null,
      }
      : null;
    // Реестр остаётся `running`, когда движок после исчерпания попыток ставит
    // STALLED_HUMAN. Для схемы это не «идёт»: красим точный узел остановкой/обрывом.
    // `stall` бывает пустым при известном узле остановки: вердикт назвал узел, а
    // журнал не назвал причину. Красить узел тогда нечем — статус оставляем как есть.
    if (stallNode && stall) statuses[stallNode] = stall.kind === 'human' ? 'stall' : 'fail';
    if ('sandbox' in def.pos) {
      if (env.FE_PORT) statuses.sandbox = 'done';
      else if (sandbox) statuses.sandbox = alive ? 'run' : 'fail';
      // Файла прогресса может не быть вовсе (его затирали битой ссылкой — см.
      // отдельный sidecar связи в профиле). Тогда решает журнал: раз конвейер встал
      // на подъёме стенда, ромб обязан гореть провалом. Без этой ветки статус падал
      // на догадку computeNodeStatuses «цепочка тронута → песочница готова», и
      // упавший стенд показывался зелёным.
      else if (stall?.stage === 'SANDBOX') statuses.sandbox = 'fail';
      else if (!alive && !env.FE_PORT && statuses.sandbox === 'done') statuses.sandbox = 'pending';
    }

    // У route-v2 чистую работу считаем по реально запущенным runner-процессам этой
    // trusted attempt. Bootstrap Scout не входит в закреплённую машину маршрута и в
    // счётчик не попадает. Старый event-to-event ledger оставлен для gate wait и
    // исторических read-only реестров: его рабочие интервалы включают простой после
    // падения оркестратора, поэтому для исполняемой попытки ими пользоваться нельзя.
    const runnerStages = [...new Set(Object.keys(executablePos)
      .filter((nid) => nid !== 'scout' && (!('nodeOrigins' in def)
        || def.nodeOrigins[nid]?.scope !== 'bootstrap') && def.nodes[nid]?.[0] === 'agent')
      .map((nid) => def.runnerKeys[nid] || def.keys[nid] || nid.toUpperCase()))];
    const workTime = await this.readWorkTime(task, registry, trusted, mtime, {
      stateDir,
      runnerStages,
    });
    const working = alive && !stall && Object.entries(statuses).some(([nid, status]) => (
      status === 'run' && nid !== 'sandbox' && def.nodes[nid]?.[0] !== 'human'
    ));
    const timing = workTime === null ? null : {
      workSec: workTime.workSec,
      gateWaitSec: workTime.gateWaitSec,
      runningSinceMs: working
        ? (workTime.runningSinceMs
          ?? (workTime.lastEventSec > 0 ? workTime.lastEventSec * 1000 : null))
        : null,
      source: workTime.source,
      approximate: workTime.approximate,
    };

    // Прогресс: done/skip/idle из узлов маршрута.
    const chain = Object.keys(executablePos).filter((n) => n !== 'sandbox');
    const doneCount = chain.filter((n) => ['done', 'skip', 'idle'].includes(String(statuses[n]))).length;
    const cur = chain.find((n) => [
      'run', 'wait', 'premature', 'stall', 'fail', 'skipbad',
    ].includes(String(statuses[n]))) || null;

    // Мета каждого узла (для модалки этапа): время/длительность/фанаут/возвраты/токены.
    const nodeMeta: Record<string, Record<string, unknown>> = {};
    await Promise.all(Object.keys(def.pos).map(async (nid) => {
      const key = def.keys[nid] || nid.toUpperCase();
      const runnerKey = def.runnerKeys[nid] || key;
      nodeMeta[nid] = {
        at: registry[`${key}_AT`] || null,
        dur: registry[`DUR_${key}`] ? Number(registry[`DUR_${key}`]) : null,
        fanout: registry[`FANOUT_${key}`] ? Number(registry[`FANOUT_${key}`]) : null,
        // Отказы политики прав внутри хода. Ключа нет — движок НЕ ЗНАЕТ (ход оборвался
        // до события result), и это не то же самое, что записанный ноль. Строгая
        // проверка, а не truthy: `'0'` — правдивый ноль, а мусор из реестра — не число.
        denials: /^\d+$/.test(registry[`DENIALS_${key}`] || '')
          ? Number(registry[`DENIALS_${key}`])
          : null,
        fails: registry[`${key}_FAILS`] ? Number(registry[`${key}_FAILS`]) : 0,
        tokens: registry[`TOKENS_${key}`] ? Number(registry[`TOKENS_${key}`]) : null,
        // Объяснение статуса от движка/агента: причина пропуска, замечание провалившегося
        // этапа. Раньше жило только в журнале прогона — на схеме было голое «пропущен».
        comment: registry[`${key}_COMMENT`] || null,
        // Причина привязана к конкретному узлу, чтобы модалка этапа и сам SVG не
        // пытались повторно угадывать её по строкам журнала.
        stall: stall?.node === nid ? stall : null,
        // Вердикт последнего захода: `owner`, находки, просмотренные файлы. Текст пишет
        // агент — недоверенные данные, рисуются только интерполяцией.
        verdict: nid === bootstrapNode && trusted?.bootstrapStop
          ? bootstrapNodeVerdict(trusted.bootstrapStop)
          : verdicts[nid] || null,
        bootstrapStop: nid === bootstrapNode && !trusted?.terminal ? trusted?.bootstrapStop || null : null,
      };
      // Только agent-узлы запускаются через multi-runner. Для code/human цепочка
      // выглядела бы обещанием запуска ИИ там, где работает shell или ждёт человек.
      if (def.nodes[nid]?.[0] === 'agent') {
        const runner = resolveRunnerState(runnerConfig, registry, runnerKey);
        const attempts = await readRunnerAttempts(stateDir, task, runnerKey);
        // Этап и попытки — проекция для UI поверх политики runner-а, а не её поля.
        nodeMeta[nid] = {
          ...nodeMeta[nid],
          runner: {
            ...runner,
            stage: runnerKey,
            attempts,
            reason: activeRunnerReason(runner, attempts),
          },
        };
      }
    }));

    return {
      task,
      profile,
      route,
      readOnly: !executable,
      workspaceMode: trusted?.workspaceMode || parsedSandbox.workspaceMode,
      vb: def.vb,
      nodes: def.nodes,
      pos: def.pos,
      edges: def.edges,
      // Без происхождения узлов клиент считает исполняемым любой узел схемы и
      // открывает на служебном модалку этапа с «Перейти сюда».
      nodeOrigins,
      statuses,
      nodeMeta,
      // Глобальный override задачи важнее project policy и должен быть виден уже
      // в шапке карточки. Stage override остаётся только на соответствующем узле.
      runnerPolicy: resolveRunnerState(runnerConfig, registry, ''),
      keys: def.keys,
      runnerKeys: def.runnerKeys,
      loops: loops.loops,
      loop: 'loop' in def ? def.loop : null,
      loopProgress: 'loop' in def && def.loop ? readLoopProgress(registry) : null,
      halted: loops.halted,
      wfStatus: registry.WF_STATUS || null,
      orchPid: registry.ORCH_PID || null,
      daemonAlive: alive,
      stall,
      fePort: env.FE_PORT || null,
      apiPort: env.API_PORT || null,
      // Стенд ещё строится (портов нет) — отдаём прогресс сборки для футера карточки.
      sandbox,
      progress: { done: doneCount, total: chain.length, current: cur },
      // Чистая работа узлов текущей попытки без ожидания человека на воротах.
      // Для route-v2 это сумма реальных runner-запусков; при утраченной телеметрии
      // возвращаем null, а не заведомо ложный календарный интервал из старого ledger.
      timing,
      // Что арбитр решил по дороге, пока человека не звали. Ворота — теперь единственная
      // точка его контроля, а карточка разбора живёт в плашке ОСТАНОВКИ, которой у ворот
      // нет: без этой сводки человек принимал бы план и результат, не зная, сколько раз
      // конвейер разворачивался сам и какие развилки закрыли за него.
      arbiterLog: this.arbiterCards?.read(task, trusted?.attempt)?.history || [],
      updatedAt: mtime,
    };
  }

  /** Профили, у которых есть корневая схема profiles/<name>/graph.json. */
  discoverProfiles() {
    try {
      return fs.readdirSync(this.profilesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()
          && fs.existsSync(path.join(this.profilesDir, entry.name, 'graph.json')))
        .map((entry) => entry.name)
        .sort();
    } catch { return []; }
  }

  /** Профиль по умолчанию для UI: из активных задач, иначе первый обнаруженный. */
  async primaryProfile() {
    const ids = await this.listTaskIds();
    for (const id of ids) {
      try {
        const { registry } = await this.readRegistry(id);
        const trusted = await this.readTrustedAttempt(id, registry);
        if (trusted.profile) return trusted.profile;
      }
      catch { /* пропускаем */ }
    }
    return this.discoverProfiles()[0] || null;
  }

  /** Все задачи с краткими карточками. */
  async listTasks() {
    const ids = await this.listTaskIds();
    const out: Array<Awaited<ReturnType<FactoryStateAdapter['getTaskSummary']>>> = [];
    for (const id of ids) {
      try {
        out.push(await this.getTaskSummary(id));
      } catch {
        // битый/исчезнувший файл — пропускаем, не роняем список
      }
    }
    return out;
  }
}
