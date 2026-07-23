// FactoryStateAdapter — единственная точка чтения состояния фабрики.
// Изолирует хрупкий файловый источник (`~/.factory/state`) от остального сервера:
// читает `tNNNN.pipeline` (реестр), `logs/tNNNN.stages.log` (таймлайн), проверяет
// живость демона по `/proc/<ORCH_PID>`. Только ЧТЕНИЕ — мутации идут через factory-cli.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parsePipeline } from '../lib/pipeline-parse.js';
import { parseStagesLog } from '../lib/stages-parse.js';
import { loadGraph, graphForRoute, computeNodeStatuses, parseLoops } from '../lib/factory-graph.js';

// Этапы конвейера по маршрутам (порядок ключей реестра). Держим здесь, чтобы
// собирать статус-карту предсказуемо; форма графа (координаты) придёт из
// profiles/<profile>.graph.json на этапе модуля «Конвейер».
const ROUTE_STAGES = {
  feature: ['SCOUT', 'PLAN', 'SKEPTIC', 'VALIDATE', 'TRANSLATOR', 'GATE_PLAN', 'TESTS',
    'TCRITIC', 'BUILD', 'SIMPLIFY', 'REVIEW', 'TRACE', 'PHPCHECK', 'LINT', 'BROWSER',
    'GATE_ACCEPT', 'SHIP', 'DEMO_ASK', 'DEMO', 'GATE_DEMO', 'RETRO'],
  debug: ['SCOUT', 'REPRO', 'INSTRUMENT', 'DIAGNOSE', 'HYPOSKEPTIC', 'PROOF', 'TRANSLATOR',
    'GATE_CAUSE', 'TESTS', 'BUILD', 'REVIEW', 'MEASURE', 'PHPCHECK', 'LINT',
    'GATE_ACCEPT', 'SHIP', 'RETRO'],
  trivial: ['SCOUT', 'BUILD', 'REVIEW', 'PHPCHECK', 'LINT', 'GATE_ACCEPT', 'SHIP', 'RETRO'],
};

export class FactoryStateAdapter {
  /** @param {{ stateDir: string, factoryHome: string }} opts */
  constructor({ stateDir, factoryHome }) {
    this.stateDir = stateDir;
    this.factoryHome = factoryHome;
    this.logsDir = path.join(stateDir, 'logs');
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

  /** Список номеров задач из глоба `t*.pipeline`. */
  async listTaskIds() {
    let files = [];
    try {
      files = await fsp.readdir(this.stateDir);
    } catch {
      return [];
    }
    const ids = [];
    for (const f of files) {
      const m = /^t(\d+)\.pipeline$/.exec(f);
      if (m) ids.push(m[1]);
    }
    // Стабильный числовой порядок (как в dashboard.collect_sandboxes).
    ids.sort((a, b) => (a.length - b.length) || a.localeCompare(b));
    return ids;
  }

  /** Сырой реестр одной задачи + время модификации. */
  async readRegistry(task) {
    const file = path.join(this.stateDir, `t${task}.pipeline`);
    const [text, stat] = await Promise.all([
      fsp.readFile(file, 'utf8'),
      fsp.stat(file),
    ]);
    return { registry: parsePipeline(text), mtime: stat.mtimeMs };
  }

  /** Карта статусов этапов маршрута: STAGE → { status, at, fails, dur, fanout }. */
  buildStageMap(registry) {
    const route = registry.ROUTE || 'feature';
    const stages = ROUTE_STAGES[route] || ROUTE_STAGES.feature;
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

  /** Краткая карточка задачи для списка. */
  async getTaskSummary(task) {
    const { registry, mtime } = await this.readRegistry(task);
    const { route, stages, map } = this.buildStageMap(registry);
    return {
      task,
      route,
      profile: registry.PROFILE || null,
      wfStatus: registry.WF_STATUS || null,
      orchPid: registry.ORCH_PID || null,
      daemonAlive: this.isDaemonAlive(registry.ORCH_PID, task),
      needsRun: registry.NEEDS_RUN === '1',
      stalledHuman: registry.STALLED_HUMAN === '1',
      stages,
      stageMap: map,
      updatedAt: mtime,
    };
  }

  /** Полная деталь задачи: реестр + карта этапов + таймлайн из stages.log. */
  async getTaskDetail(task) {
    const summary = await this.getTaskSummary(task);
    const { registry } = await this.readRegistry(task);
    let timeline = [];
    try {
      const log = await fsp.readFile(path.join(this.logsDir, `t${task}.stages.log`), 'utf8');
      timeline = parseStagesLog(log);
    } catch {
      timeline = [];
    }
    return { ...summary, registry, timeline };
  }

  /**
   * Полный граф конвейера задачи: определение схемы (узлы/рёбра/позиции) +
   * статус каждого узла + возвраты. Всё для отрисовки SVG-графа на клиенте.
   */
  async getTaskGraph(task) {
    const { registry, mtime } = await this.readRegistry(task);
    const profile = registry.PROFILE;
    if (!profile) throw new Error(`у задачи t${task} нет PROFILE в реестре`);
    const g = loadGraph(this.factoryHome, profile);
    const route = registry.ROUTE || g.default_route;
    const def = graphForRoute(g, route);
    const statuses = computeNodeStatuses({
      pf: registry, pos: def.pos, keys: def.keys, optional: def.optional, mtimeMs: mtime,
    });
    let loops = { loops: {}, halted: null, haltMsg: '' };
    try {
      const log = await fsp.readFile(path.join(this.logsDir, `t${task}.stages.log`), 'utf8');
      loops = parseLoops(log);
    } catch { /* журнала нет */ }

    // Порты стенда — в tNNNN.env (не в реестре .pipeline).
    let env = {};
    try {
      env = parsePipeline(await fsp.readFile(path.join(this.stateDir, `t${task}.env`), 'utf8'));
    } catch { /* env нет */ }

    // Прогресс: done/skip/idle из узлов маршрута.
    const chain = Object.keys(def.pos).filter((n) => n !== 'sandbox');
    const doneCount = chain.filter((n) => ['done', 'skip', 'idle'].includes(statuses[n])).length;
    const cur = chain.find((n) => ['run', 'wait', 'premature'].includes(statuses[n])) || null;

    // Мета каждого узла (для модалки этапа): время/длительность/фанаут/возвраты/токены.
    const nodeMeta = {};
    for (const nid of Object.keys(def.pos)) {
      const key = def.keys[nid] || nid.toUpperCase();
      nodeMeta[nid] = {
        at: registry[`${key}_AT`] || null,
        dur: registry[`DUR_${key}`] ? Number(registry[`DUR_${key}`]) : null,
        fanout: registry[`FANOUT_${key}`] ? Number(registry[`FANOUT_${key}`]) : null,
        fails: registry[`${key}_FAILS`] ? Number(registry[`${key}_FAILS`]) : 0,
        tokens: registry[`TOKENS_${key}`] ? Number(registry[`TOKENS_${key}`]) : null,
      };
    }

    return {
      task,
      profile,
      route,
      vb: def.vb,
      nodes: def.nodes,
      pos: def.pos,
      edges: def.edges,
      statuses,
      nodeMeta,
      keys: def.keys,
      loops: loops.loops,
      halted: loops.halted,
      wfStatus: registry.WF_STATUS || null,
      orchPid: registry.ORCH_PID || null,
      daemonAlive: this.isDaemonAlive(registry.ORCH_PID, task),
      fePort: env.FE_PORT || null,
      apiPort: env.API_PORT || null,
      progress: { done: doneCount, total: chain.length, current: cur },
      updatedAt: mtime,
    };
  }

  /** Профили, у которых есть схема (сканирует factory/profiles/*.graph.json). */
  discoverProfiles() {
    try {
      return fs.readdirSync(path.join(this.factoryHome, 'profiles'))
        .filter((f) => f.endsWith('.graph.json'))
        .map((f) => f.replace('.graph.json', ''));
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
    const g = loadGraph(this.factoryHome, profile);
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
