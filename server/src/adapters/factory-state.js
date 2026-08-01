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
import { buildV2RouteDef, v2StageKeys } from '../lib/route-v2-graph.js';
import { RoutesV2Store } from '../modules/routes/store-v2.js';
import {
  activeRunnerReason,
  loadRunnerConfig,
  readRunnerAttempts,
  resolveRunnerState,
} from '../lib/runner-state.js';

// Этапы конвейера по маршрутам (порядок ключей реестра). Держим здесь, чтобы
// собирать статус-карту предсказуемо; форма графа (координаты) придёт из
// profiles/<profile>/graph.json на этапе модуля «Конвейер».
// DEMO-ключей здесь нет намеренно: демо убрано из цепочки фабрики (2026-07-27) и снимается
// по кнопке плагина «Демо» (factory <task> demo). Пока они числились этапами маршрута,
// прогресс feature не доходил до 100%, а дошедшая до ретро задача выглядела недоделанной.
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
  /** @param {{ stateDir: string, profilesDir: string, stateV2Dir?: string|null, routesV2Dir?: string|null }} opts */
  constructor({ stateDir, profilesDir, stateV2Dir = null, routesV2Dir = null }) {
    this.stateDir = stateDir;
    this.stateV2Dir = stateV2Dir;
    this.profilesDir = profilesDir;
    this.routesV2Dir = routesV2Dir;
    this._routesV2Store = null;
  }

  /**
   * Форма графа v2-задачи — из ЗАКРЕПЛЁННОГО бандла (реестр несёт profile, route
   * и routeHash пина). Возвращает null, если это не v2-задача или бандл
   * недоступен, — тогда рисуем v1-форму как раньше.
   */
  async v2RouteDef(registry) {
    if (registry.CATALOG_PROTOCOL !== 'route-v2' || !this.routesV2Dir
        || !registry.PROFILE || !registry.ROUTE
        || !/^[a-f0-9]{64}$/.test(registry.ROUTE_HASH || '')) return null;
    try {
      this._routesV2Store ||= new RoutesV2Store({ baseDir: this.routesV2Dir });
      const { route } = await this._routesV2Store.readRoute(
        registry.PROFILE,
        registry.ROUTE,
        registry.ROUTE_HASH,
      );
      // Поля машины в route.json верхнеуровневые (sequence/nodes/entry).
      return buildV2RouteDef(
        { entry: route.entry, sequence: route.sequence, nodes: route.nodes },
        registry.ROUTE,
      );
    } catch {
      return null; // бандл потерян/испорчен — честная v1-форма лучше 500
    }
  }

  /**
   * Каталог, где реально живёт реестр задачи. Протокол route v2 держит состояние
   * в отдельном stateV2Dir (движок требует непересечения с legacy), поэтому все
   * чтения идут через это разрешение. Коллизий не бывает: v2-старт отказывает
   * задаче, у которой есть legacy-реестр.
   */
  async taskStateDir(task) {
    if (this.stateV2Dir) {
      try {
        await fsp.access(path.join(this.stateV2Dir, `t${task}.pipeline`));
        return this.stateV2Dir;
      } catch { /* не v2 — читаем legacy */ }
    }
    return this.stateDir;
  }

  /** Задача прогона v2? Мутации v1-CLI (runner switch, снос песочницы) к ней неприменимы. */
  async isV2Task(task) {
    return this.stateV2Dir !== null && (await this.taskStateDir(task)) === this.stateV2Dir;
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
      const hasBin = argv.some((a) => a.endsWith('/bin/factory') || a === 'bin/factory' || a.includes('bin/factory'));
      const hasTask = argv.includes(String(task));
      return hasBin && hasTask;
    } catch {
      return false; // нет /proc/<pid> → мёртв
    }
  }

  /** Список номеров задач из глоба `t*.pipeline` — по обоим поколениям состояния. */
  async listTaskIds() {
    const ids = new Set();
    for (const dir of [this.stateDir, this.stateV2Dir]) {
      if (!dir) continue;
      let files = [];
      try {
        files = await fsp.readdir(dir);
      } catch { continue; }
      for (const f of files) {
        const m = /^t(\d+)\.pipeline$/.exec(f);
        if (m) ids.add(m[1]);
      }
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

  /** Карта статусов этапов маршрута: STAGE → { status, at, fails, dur, fanout }. */
  buildStageMap(registry) {
    const route = registry.ROUTE || 'feature';
    // v2-реестр несёт РОВНО узлы закреплённого бандла (в порядке машины) —
    // никаких захардкоженных списков этапов.
    const stages = registry.CATALOG_PROTOCOL === 'route-v2'
      ? v2StageKeys(registry)
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
    // Причина остановки идёт В СВОДКУ, а не только в деталь задачи: затык надо видеть
    // в списке, не открывая карточку. Иначе движок ждёт человека, а в интерфейсе это
    // выглядит обычным «○ стоит», как у доделанной задачи.
    const timeline = await this.readTimeline(task);
    return {
      task,
      route,
      // Поколение прогона: v2-задачами управляет factory-v2, мутации v1-CLI к ним
      // неприменимы — UI и ручки сервера смотрят на этот флаг.
      generation: (await this.isV2Task(task)) ? 'v2' : 'v1',
      profile: registry.PROFILE || null,
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
    let def = await this.v2RouteDef(registry);
    let route = registry.ROUTE;
    if (!def) {
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

    // Порты стенда — в tNNNN.env (не в реестре .pipeline).
    let env = {};
    try {
      env = parsePipeline(await fsp.readFile(path.join(stateDir, `t${task}.env`), 'utf8'));
    } catch { /* env нет */ }

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
      generation: this.stateV2Dir && stateDir === this.stateV2Dir ? 'v2' : 'v1',
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
      try { const { registry } = await this.readRegistry(id); if (registry.PROFILE) return registry.PROFILE; }
      catch { /* пропускаем */ }
    }
    return this.discoverProfiles()[0] || null;
  }

  /** Эталонные схемы всех маршрутов профиля (для раздела «Маршруты»). */
  getRoutes(profile) {
    if (!profile) throw new Error('профиль не указан');
    const g = loadGraph(this.profilesDir, profile);
    const routes = {};
    for (const route of Object.keys(g.routes)) {
      const def = graphForRoute(g, route);
      routes[route] = { nodes: def.nodes, pos: def.pos, edges: def.edges };
    }
    return { profile, default: g.default_route, routes };
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
