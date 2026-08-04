// FactoryStateAdapter — единственная точка чтения состояния фабрики.
// Изолирует хрупкий файловый источник (`~/.factory/state`) от остального сервера:
// читает `tNNNN.pipeline` (реестр), `logs/tNNNN.stages.log` (таймлайн), проверяет
// живость демона по `/proc/<ORCH_PID>`. Только ЧТЕНИЕ — мутации идут через factory-cli.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parsePipeline } from '../lib/pipeline-parse.js';
import { parseStagesLog } from '../lib/stages-parse.js';
import { detectStall } from '../lib/stall.js';
import { readRunSilence } from '../lib/factory-cli.js';
import { loadGraph, graphForRoute, computeNodeStatuses, parseLoops } from '../lib/factory-graph.js';
import { buildRouteDef, routeStageKeys } from '../lib/route-graph.js';
import { RoutesStore } from '../modules/routes/store.js';
import { parseSandboxRepositories } from '../lib/sandbox-env.js';
import {
  readFactoryAttemptLedger,
  verifyFactoryAttemptEnvironment,
} from '../lib/factory-attempt-ledger.js';
import {
  activeRunnerReason,
  loadRunnerConfig,
  readRunnerAttempts,
  resolveRunnerState,
} from '../lib/runner-state.js';

// Этапы конвейера по маршрутам (порядок ключей реестра). Держим здесь, чтобы
// собирать статус-карту предсказуемо; форма графа (координаты) придёт из
// profiles/<profile>/graph.json на этапе модуля «Конвейер».
// DEMO-ключей здесь нет: демо убрано из цепочки фабрики (2026-07-27), а сама съёмка
// удалена вместе с плагином (2026-08-01) — видео живёт в отдельном сервисе. Пока DEMO
// числился этапом маршрута, прогресс feature не доходил до 100%, а дошедшая до ретро
// задача выглядела недоделанной.
const ROUTE_STAGES = {
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
function stallNodeId(def, statuses, stage) {
  if (!stage) return null;
  const candidates = Object.keys(def.pos).filter((nid) => [
    def.keys[nid],
    def.runnerKeys[nid],
    nid.toUpperCase(),
  ].includes(stage));
  return candidates.find((nid) => ['run', 'wait', 'premature', 'stall'].includes(statuses[nid]))
    || candidates.find((nid) => def.keys[nid] === stage)
    || candidates[0]
    || null;
}

export class FactoryStateAdapter {
  /**
   * @param {{
   *   stateDir: string,
   *   profilesDir: string,
   *   routesDir?: string|null,
   *   controlDir?: string|null,
   *   workTimeReader?: ((identity: {task:string,profile:string,attempt:string}) => Promise<object|null>)|null,
   * }} opts
   */
  constructor({
    stateDir, profilesDir, routesDir = null, controlDir = null, workTimeReader = null,
  }) {
    this.stateDir = stateDir;
    this.profilesDir = profilesDir;
    this.routesDir = routesDir;
    this.controlDir = controlDir;
    this.workTimeReader = workTimeReader;
    this._workTimeCache = new Map();
    this._routesStore = null;
  }

  /** Только синтаксис UI-проекции; разрешением на исполнение эта проверка не является. */
  hasRouteProjectionIdentity(registry) {
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
  async readTrustedAttempt(task, registry = null) {
    const projection = registry || (await this.readRegistry(task)).registry;
    return readFactoryAttemptLedger({
      controlDir: this.controlDir,
      stateDir: this.stateDir,
      task: String(task),
      registry: projection,
    });
  }

  /** Перед destructive lifecycle mutable `.env` обязан точно совпасть с pin профиля. */
  verifyTrustedEnvironment(trusted, env) {
    return verifyFactoryAttemptEnvironment(trusted, env);
  }

  /**
   * Форма графа текущей задачи — только из ЗАКРЕПЛЁННОГО бандла. Потерянный или
   * подменённый pin является ошибкой целостности, а не поводом открыть legacy graph.
   */
  async routeDef(registry, opts = {}) {
    if (!this.hasRouteProjectionIdentity(registry) || !this.routesDir) {
      throw new Error('реестр не содержит полностью закреплённую route-attempt identity');
    }
    try {
      this._routesStore ||= new RoutesStore({ baseDir: this.routesDir });
      const { route } = await this._routesStore.readRoute(
        registry.PROFILE,
        registry.ROUTE,
        registry.ROUTE_HASH,
      );
      // Поля машины в route.json верхнеуровневые (sequence/nodes/entry).
      return buildRouteDef(
        { entry: route.entry, sequence: route.sequence, nodes: route.nodes },
        registry.ROUTE,
        opts,
      );
    } catch (err) {
      throw new Error(`закреплённый маршрут недоступен или повреждён: ${err.message}`);
    }
  }

  /**
   * Маршруты ОПУБЛИКОВАННОГО каталога профиля — то, из чего человек выбирает при
   * запуске. Список берём из бандла, а не из `graph.json` профиля: стартовать можно
   * только по опубликованному маршруту, и предложить неопубликованный значит
   * пообещать то, чего движок не примет.
   * @returns {Promise<{catalogHash:string, routes:string[],routeOptions:object}|null>}
   * null — каталог не опубликован
   */
  async catalog(profile) {
    if (!this.routesDir || !profile) return null;
    try {
      this._routesStore ||= new RoutesStore({ baseDir: this.routesDir });
      const current = await this._routesStore.readCurrent(profile);
      if (!current) return null;
      const routes = Object.keys(current.catalog.routes || {}).sort();
      const entries = await Promise.all(routes.map(async (routeId) => {
        const { route } = await this._routesStore.readRoute(
          profile,
          routeId,
          current.catalog.routes[routeId],
        );
        return [routeId, {
          deliveryMode: route.nodes.some((node) => node.id === 'ship') ? 'publish' : 'disabled',
          instrumentationRequired: routeId === 'debug',
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
  async taskStateDir(_task) {
    return this.stateDir;
  }

  /** Только такие задачи разрешено передавать единственному движку для mutation/resume. */
  async isExecutableTask(task) {
    try { await this.readTrustedAttempt(task); return true; }
    catch { return false; }
  }

  /**
   * Проверка живости демона оркестратора: pid жив И его cmdline содержит
   * `bin/factory` и номер задачи отдельным аргументом (эталон — daemon_state
   * в dashboard.py). Синхронно и дёшево.
   */
  isDaemonAlive(orchPid, task) {
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

  /** Список номеров задач из единственного runtime root. */
  async listTaskIds() {
    const ids = new Set();
    let files = [];
    try { files = await fsp.readdir(this.stateDir); } catch { return []; }
    for (const f of files) {
      const m = /^t(\d+)\.pipeline$/.exec(f);
      if (m) ids.add(m[1]);
    }
    // Стабильный числовой порядок (как в dashboard.collect_sandboxes).
    return [...ids].sort((a, b) => (a.length - b.length) || a.localeCompare(b));
  }

  /** Параметры песочницы задачи (tNNNN.env): порты, worktree-пути. */
  async readEnv(task) {
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
  async readSandboxStage(task) {
    try {
      const p = path.join(await this.taskStateDir(task), `t${task}.stage`);
      const lines = (await fsp.readFile(p, 'utf8')).trim().split('\n').filter(Boolean);
      const m = /^([^|]*)\|(\d+)\/(\d+)\|(.*)$/.exec(lines[lines.length - 1] || '');
      if (!m) return null;
      return { at: m[1], step: Number(m[2]), total: Number(m[3]), label: m[4].trim() };
    } catch { return null; }
  }

  /** Сырой реестр одной задачи + время модификации. */
  async readRegistry(task) {
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
  async readWorkTime(task, registry, trusted, mtime) {
    const uint = (value) => {
      if (!/^(0|[1-9][0-9]*)$/.test(String(value ?? ''))) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : null;
    };
    const projectedWork = uint(registry.WORK_TIME_S);
    if (projectedWork !== null) {
      return {
        workSec: projectedWork,
        gateWaitSec: uint(registry.GATE_WAIT_S) ?? 0,
        lastEventSec: uint(registry.WORK_TIMER_SINCE) ?? 0,
      };
    }
    if (!trusted || typeof this.workTimeReader !== 'function') return null;

    const cacheKey = `${trusted.attempt}:${mtime}`;
    const cached = this._workTimeCache.get(String(task));
    if (cached?.key === cacheKey) return cached.promise;

    const promise = Promise.resolve(this.workTimeReader({
      task: String(task), profile: trusted.profile, attempt: trusted.attempt,
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
    return promise;
  }

  /** Карта статусов этапов маршрута: STAGE → { status, at, fails, dur, fanout }. */
  buildStageMap(registry) {
    const route = registry.ROUTE || 'feature';
    // v2-реестр несёт РОВНО узлы закреплённого бандла (в порядке машины) —
    // никаких захардкоженных списков этапов.
    const stages = registry.CATALOG_PROTOCOL === 'route-v2'
      ? routeStageKeys(registry)
      : (ROUTE_STAGES[route] || ROUTE_STAGES.feature);
    const map = {};
    for (const key of stages) {
      map[key] = {
        status: registry[key] || 'idle', // отсутствие ключа = idle (не отслеживалось)
        at: registry[`${key}_AT`] || null,
        fails: registry[`${key}_FAILS`] ? Number(registry[`${key}_FAILS`]) : 0,
        dur: registry[`DUR_${key}`] ? Number(registry[`DUR_${key}`]) : null,
        fanout: registry[`FANOUT_${key}`] ? Number(registry[`FANOUT_${key}`]) : null,
      };
    }
    return { route, stages, map };
  }

  /** Таймлайн задачи из stages.log (пусто, если журнала нет). */
  async readTimeline(task) {
    try {
      const dir = await this.taskStateDir(task);
      return parseStagesLog(await fsp.readFile(path.join(dir, 'logs', `t${task}.stages.log`), 'utf8'));
    } catch { return []; }
  }

  /** Краткая карточка задачи для списка. */
  async getTaskSummary(task) {
    const { registry, mtime } = await this.readRegistry(task);
    const { route, stages, map } = this.buildStageMap(registry);
    const daemonAlive = this.isDaemonAlive(registry.ORCH_PID, task);
    const env = await this.readEnv(task);
    const sandbox = parseSandboxRepositories(env, { allowLegacy: true });
    let trusted = null;
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
      stalledHuman: registry.STALLED_HUMAN === '1',
      stall: detectStall({ registry, timeline, daemonAlive }),
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

  /** Полная деталь задачи: реестр + карта этапов + таймлайн из stages.log. */
  async getTaskDetail(task) {
    const summary = await this.getTaskSummary(task);
    const { registry } = await this.readRegistry(task);
    return { ...summary, registry, timeline: await this.readTimeline(task) };
  }

  /**
   * Полный граф конвейера задачи: определение схемы (узлы/рёбра/позиции) +
   * статус каждого узла + возвраты. Всё для отрисовки SVG-графа на клиенте.
   */
  async getTaskGraph(task) {
    const stateDir = await this.taskStateDir(task);
    const { registry, mtime } = await this.readRegistry(task);
    const profile = registry.PROFILE;
    if (!profile) throw new Error(`у задачи t${task} нет PROFILE в реестре`);
    let trusted = null;
    try { trusted = await this.readTrustedAttempt(task, registry); } catch { /* read-only */ }
    const executable = Boolean(trusted);
    // Порты стенда и режим workspace — в tNNNN.env (не в реестре .pipeline).
    let env = {};
    try {
      env = parsePipeline(await fsp.readFile(path.join(stateDir, `t${task}.env`), 'utf8'));
    } catch { /* env нет */ }
    let def = null;
    let route = registry.ROUTE;
    if (registry.CATALOG_PROTOCOL === 'route-v2') {
      // Маркер текущего протокола запрещает fallback: pin должен пройти полностью.
      // Режим закреплён в env попытки: shared-профиль рисуется без ромба песочницы.
      def = await this.routeDef(registry, { workspaceMode: env.WORKSPACE_MODE });
    } else {
      // Исторический legacy graph доступен только для просмотра. Mutation endpoints
      // проверяют executable identity до любых команд и записей.
      const g = loadGraph(this.profilesDir, profile);
      route = registry.ROUTE || g.default_route;
      def = graphForRoute(g, route);
    }
    const runnerConfig = loadRunnerConfig(this.profilesDir, profile);
    const statuses = computeNodeStatuses({
      pf: registry, pos: def.pos, keys: def.keys, optional: def.optional, mtimeMs: mtime,
    });
    let loops = { loops: {}, halted: null, haltMsg: '' };
    try {
      const log = await fsp.readFile(path.join(stateDir, 'logs', `t${task}.stages.log`), 'utf8');
      loops = parseLoops(log);
    } catch { /* журнала нет */ }

    const parsedSandbox = parseSandboxRepositories(env, { allowLegacy: true });

    // Честный статус ромба песочницы: порты есть → готова; идёт сборка → running
    // (при живом демоне), демон умер посреди сборки → fail. Иначе — как посчитала цепочка.
    const alive = this.isDaemonAlive(registry.ORCH_PID, task);
    const sandbox = env.FE_PORT ? null : await this.readSandboxStage(task);
    const detectedStall = detectStall({
      registry,
      timeline: await this.readTimeline(task),
      daemonAlive: alive,
    });
    const stallNode = stallNodeId(def, statuses, detectedStall?.stage);
    const stall = detectedStall ? { ...detectedStall, node: stallNode } : null;
    // Реестр остаётся `running`, когда движок после исчерпания попыток ставит
    // STALLED_HUMAN. Для схемы это не «идёт»: красим точный узел остановкой/обрывом.
    if (stallNode) statuses[stallNode] = stall.kind === 'human' ? 'stall' : 'fail';
    if ('sandbox' in def.pos) {
      if (env.FE_PORT) statuses.sandbox = 'done';
      else if (sandbox) statuses.sandbox = alive ? 'run' : 'fail';
      // Файла прогресса может не быть вовсе (его затирали битой ссылкой — см.
      // _ars_link_state в профиле arsenkin). Тогда решает журнал: раз конвейер встал
      // на подъёме стенда, ромб обязан гореть провалом. Без этой ветки статус падал
      // на догадку computeNodeStatuses «цепочка тронута → песочница готова», и
      // упавший стенд показывался зелёным.
      else if (stall?.stage === 'SANDBOX') statuses.sandbox = 'fail';
      else if (!alive && !env.FE_PORT && statuses.sandbox === 'done') statuses.sandbox = 'pending';
    }

    // Чистое время работы текущей попытки приходит из hash-chained route ledger через
    // движковую проекцию реестра. WORK_TIME_S уже суммирует ВСЕ повторные заходы узлов,
    // а GATE_WAIT_S хранит ожидание решений отдельно. Последний незавершённый рабочий
    // интервал дотикивает клиент от WORK_TIMER_SINCE, но только пока действительно жив
    // демон и горит не-human узел. Старую проекцию восстанавливаем только через
    // проверенный ledger; без него таймер не выдумываем.
    const workTime = await this.readWorkTime(task, registry, trusted, mtime);
    const working = alive && !stall && Object.entries(statuses).some(([nid, status]) => (
      status === 'run' && nid !== 'sandbox' && def.nodes[nid]?.[0] !== 'human'
    ));
    const timing = workTime === null ? null : {
      workSec: workTime.workSec,
      gateWaitSec: workTime.gateWaitSec,
      runningSinceMs: working && workTime.lastEventSec > 0
        ? workTime.lastEventSec * 1000
        : null,
    };

    // Прогресс: done/skip/idle из узлов маршрута.
    const chain = Object.keys(def.pos).filter((n) => n !== 'sandbox');
    const doneCount = chain.filter((n) => ['done', 'skip', 'idle'].includes(statuses[n])).length;
    const cur = chain.find((n) => [
      'run', 'wait', 'premature', 'stall', 'fail', 'skipbad',
    ].includes(statuses[n])) || null;

    // Мета каждого узла (для модалки этапа): время/длительность/фанаут/возвраты/токены.
    const nodeMeta = {};
    await Promise.all(Object.keys(def.pos).map(async (nid) => {
      const key = def.keys[nid] || nid.toUpperCase();
      const runnerKey = def.runnerKeys[nid] || key;
      nodeMeta[nid] = {
        at: registry[`${key}_AT`] || null,
        dur: registry[`DUR_${key}`] ? Number(registry[`DUR_${key}`]) : null,
        fanout: registry[`FANOUT_${key}`] ? Number(registry[`FANOUT_${key}`]) : null,
        fails: registry[`${key}_FAILS`] ? Number(registry[`${key}_FAILS`]) : 0,
        tokens: registry[`TOKENS_${key}`] ? Number(registry[`TOKENS_${key}`]) : null,
        // Объяснение статуса от движка/агента: причина пропуска, замечание провалившегося
        // этапа. Раньше жило только в журнале прогона — на схеме было голое «пропущен».
        comment: registry[`${key}_COMMENT`] || null,
        // Причина привязана к конкретному узлу, чтобы модалка этапа и сам SVG не
        // пытались повторно угадывать её по строкам журнала.
        stall: stall?.node === nid ? stall : null,
      };
      // Только agent-узлы запускаются через multi-runner. Для code/human цепочка
      // выглядела бы обещанием запуска ИИ там, где работает shell или ждёт человек.
      if (def.nodes[nid]?.[0] === 'agent') {
        const runner = resolveRunnerState(runnerConfig, registry, runnerKey);
        const attempts = await readRunnerAttempts(
          stateDir,
          task,
          runnerKey,
        );
        runner.stage = runnerKey;
        runner.attempts = attempts;
        runner.reason = activeRunnerReason(runner, attempts);
        nodeMeta[nid].runner = runner;
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
      statuses,
      nodeMeta,
      // Глобальный override задачи важнее project policy и должен быть виден уже
      // в шапке карточки. Stage override остаётся только на соответствующем узле.
      runnerPolicy: resolveRunnerState(runnerConfig, registry, ''),
      keys: def.keys,
      runnerKeys: def.runnerKeys,
      loops: loops.loops,
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
      // null только когда нет ни реестровой проекции, ни доступного trusted ledger.
      timing,
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
    const out = [];
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
