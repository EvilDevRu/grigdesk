// Форма графа route-задачи из ЗАКРЕПЛЁННОГО бандла попытки: узлы, ключи, позиции
// и рёбра выводятся из машины маршрута (sequence + переходы), а не из v1
// graph.json. Иначе UI рисует скептика/валидатора/переводчика, которых в машине
// не существует, «5/18» по чужим узлам и модели
// чужих этапов — человек у ворот принимал решение по ложной картине.
import { resolveNode } from './stages.ts';
import type { ResolvedNode } from './stages.ts';

// Переход маршрута: вперёд по `next`, назад по `rewind` либо остановка по `stop`.
export interface RouteTransition {
  next?: string;
  rewind?: string;
  stop?: string;
}

// Узел машины маршрута из закреплённого бандла попытки.
export interface RouteMachineNode {
  id: string;
  runKey: string;
  label?: string;
  executor?: string;
  policy?: { filesystem?: string };
  on?: Record<string, RouteTransition | undefined>;
  onFailure?: Record<string, RouteTransition | undefined>;
}

// Машина маршрута: узлы и последовательность исполнения (основная часть и хвост).
export interface RouteMachine {
  nodes?: RouteMachineNode[];
  sequence: { main: string[]; tail: string[] };
  entry?: string;
}

// Ребро схемы: откуда, куда, подпись, класс линии и способ прокладки.
export type RouteGraphEdge = [string, string, string, string, string];

// Форма графа в том же контракте, что отдавал graphForRoute (v1).
export interface RouteGraphDef {
  nodes: Record<string, ResolvedNode>;
  keys: Record<string, string>;
  runnerKeys: Record<string, string>;
  optional: string[];
  forwardOnFailure: string[];
  vb: string;
  pos: Record<string, [number, number]>;
  edges: RouteGraphEdge[];
  route: string;
}

// Дуга возврата: узел-источник, подпись перехода, цель и их места в цепочке.
interface RewindArc {
  node: RouteMachineNode;
  label: string;
  target: string;
  from: number;
  to: number;
  routing: string;
}

// Канон раскладки v1 (profiles/*/graph.json рисовали руками): широкий шаг колонок,
// змейка «бустрофедон» — ряды идут туда-обратно, поэтому соседние по маршруту узлы
// всегда рядом, а переход на следующий ряд — короткая вертикаль, а не диагональ
// через весь холст.
const CELL_W = 340;
const ROW_H = 160;
const PER_ROW = 6;
const X0 = 140;
const Y0 = 50;

/**
 * Строит форму графа по машине маршрута из бандла попытки.
 * `opts.workspaceMode === 'shared'` убирает ромб песочницы: стенд там чужой и постоянный.
 */
export function buildRouteDef(
  machine: RouteMachine,
  route: string,
  opts: { workspaceMode?: string } = {},
): RouteGraphDef {
  const byId = new Map((machine.nodes || []).map((n) => [n.id, n]));
  // Визуальная цепочка: bootstrap Scout (живёт в каталоге, не в машине маршрута)
  // + main + tail. Status-узлы — не этапы исполнения, в цепочку не входят.
  const chainIds = ['scout', ...machine.sequence.main, ...machine.sequence.tail]
    .filter((id) => {
      if (id === 'scout') return true;
      const node = byId.get(id);
      return node && node.executor !== 'status';
    });

  const KIND: Record<string, string | undefined> = {
    agent: 'agent',
    gate: 'human',
    command: 'code',
  };
  const nodes: Record<string, ResolvedNode> = {};
  const keys: Record<string, string> = {};
  const pos: Record<string, [number, number]> = {};
  const edges: RouteGraphEdge[] = [];

  chainIds.forEach((id, index) => {
    const node = byId.get(id);
    if (!node) {
      // Без узла бандла в цепочке остаётся только bootstrap-разведка: её каталог
      // держит кокпит, а машина маршрута про неё не знает.
      nodes[id] = resolveNode(id, null);
      keys[id] = id.toUpperCase();
    } else {
      // Подпись — из бандла (это его данные), каталог стадий кокпита нужен лишь
      // как запасной вариант для узлов без label: маршрут нового проекта не
      // обязан пользоваться привычными именами этапов.
      nodes[id] = [
        KIND[String(node.executor)] || 'agent',
        node.label || resolveNode(id, null)[1],
        '',
      ];
      keys[id] = node.runKey;
    }
    const row = Math.floor(index / PER_ROW);
    const col = index % PER_ROW;
    // Нечётные ряды разворачиваем: конец ряда стыкуется с началом следующего.
    const x = row % 2 === 0 ? col : PER_ROW - 1 - col;
    pos[id] = [X0 + x * CELL_W, Y0 + row * ROW_H];
  });

  // Песочница — ромб готовности стенда (статус даёт адаптер из tN.env). Стенд
  // поднимается ПАРАЛЛЕЛЬНО разведке: из стартовой точки две линии — в Scout и в
  // песочницу, а «стенд готов» приходит к первому узлу, которому нужна запись в
  // рабочее дерево (у v1 это tests). Узел ищем по политике бандла, без имён.
  // Shared-профилю рисовать ромб нельзя: песочницы там нет вовсе — стенд чужой,
  // постоянный и никем не поднимается, а lease/health происходят до старта разведки.
  const rows = Math.ceil(chainIds.length / PER_ROW);
  const withSandbox = opts.workspaceMode !== 'shared';
  const firstWriteId = chainIds.find((id) => {
    const policy = byId.get(id)?.policy?.filesystem;
    return policy && policy !== 'state-only';
  }) || chainIds[1] || 'scout';
  if (withSandbox) {
    nodes.sandbox = resolveNode('sandbox', null);
    pos.sandbox = [X0 + Math.floor(PER_ROW / 2) * CELL_W, Y0 + Math.floor(ROW_H / 2)];
  }
  edges.push(['_start', chainIds[0] ?? 'scout', '', 'plain', 'h']);
  if (withSandbox) {
    edges.push(['_start', 'sandbox', '', 'plain', 'to_sandbox']);
    edges.push(['sandbox', firstWriteId, 'стенд готов', 'plain', 'from_sandbox']);
  }

  // Прямой ход: внутри ряда — горизонталь, стык рядов — вертикаль (как v1).
  for (let i = 0; i + 1 < chainIds.length; i += 1) {
    const sameRow = Math.floor(i / PER_ROW) === Math.floor((i + 1) / PER_ROW);
    edges.push([chainIds[i] ?? '', chainIds[i + 1] ?? '', '', 'plain', sameRow ? 'h' : 'v']);
  }

  // Возвраты (rewind) — красные дуги, как v1: чем дальше прыжок назад, тем выше
  // дуга, поэтому линии не сливаются в один пучок. Возврат внутри ряда идёт
  // поверху, между рядами — понизу.
  const indexOf = new Map(chainIds.map((id, i) => [id, i]));
  const UP = ['arc_up', 'arc_up_hi'];
  const DOWN = ['arc_down', 'arc_down_hi', 'arc_down_x2', 'arc_down_x3', 'arc_reject'];
  const rewinds: RewindArc[] = [];
  for (const node of machine.nodes || []) {
    const transitions = [
      ...Object.entries(node.on || {}).map(([outcome, transition]) => ({
        label: outcome,
        transition,
      })),
      ...Object.entries(node.onFailure || {}).map(([owner, transition]) => ({
        label: `failed:${owner}`,
        transition,
      })),
    ];
    for (const { label, transition } of transitions) {
      if (!transition || typeof transition !== 'object' || !transition.rewind) continue;
      if (!(transition.rewind in pos) || !(node.id in pos)) continue;
      const from = indexOf.get(node.id) ?? 0;
      const to = indexOf.get(transition.rewind) ?? 0;
      rewinds.push({
        node,
        label,
        target: transition.rewind,
        from,
        to,
        routing: '',
      });
    }
  }
  // Верхний ряд обходим поверху, остальные — понизу (v1: skeptic→plan дугой
  // вверх, review/trace/lint→build дугами вниз). Внутри семейства амплитуда
  // растёт с дальностью прыжка, иначе линии сливаются в один пучок.
  const upList = rewinds.filter((r) => Math.floor(r.from / PER_ROW) === 0);
  const downList = rewinds.filter((r) => Math.floor(r.from / PER_ROW) > 0);
  const byDistance = (a: RewindArc, b: RewindArc) => (
    Math.abs(a.from - a.to) - Math.abs(b.from - b.to)
  );
  // Амплитуда дуги растёт с дальностью прыжка и упирается в последнюю форму семейства.
  const routingOf = (family: readonly string[], index: number) => (
    family[Math.min(index, family.length - 1)] || ''
  );

  upList.sort(byDistance).forEach((r, i) => {
    r.routing = routingOf(UP, i);
  });
  downList.sort(byDistance).forEach((r, i) => {
    r.routing = routingOf(DOWN, i);
  });
  for (const r of rewinds) {
    edges.push([r.node.id, r.target, `✗ ${r.label}`, 'fail', r.routing]);
  }

  const width = X0 + PER_ROW * CELL_W;
  const height = Y0 + (rows + 1) * ROW_H + 120;
  // Optional — свойство перехода машины, а не отдельная ручная карта UI.
  // skipped→stop означает аномалию/остановку; любой иной штатный переход
  // разрешает показывать skipped без skipbad и ложного premature на воротах.
  const optional = chainIds.filter((id) => {
    const transition = byId.get(id)?.on?.skipped;
    return transition
      && typeof transition === 'object'
      && !Object.hasOwn(transition, 'stop');
  });

  // Узлы, чей провал по контракту ведёт маршрут ВПЕРЁД: член совета, у которого
  // кончилась квота провайдера, и ретро, чей отказ не отменяет публикацию. Реестр
  // пишет им `failed` (для exhausted — тоже), и без этого списка выпадение рисуется
  // красным «конвейер упёрся» — неотличимо от места, где маршрут действительно встал.
  // Rewind сюда не входит: возврат назад остановкой не является, но и пропуском тоже.
  const forwardOnFailure = chainIds.filter((id) => {
    const node = byId.get(id);
    if (!node || node.executor === 'gate') return false;
    return ['failed', 'exhausted'].every((outcome) => {
      const transition = node.on?.[outcome];
      return transition
        && typeof transition === 'object'
        && typeof transition.next === 'string';
    });
  });

  return {
    nodes,
    keys,
    runnerKeys: { ...keys },
    optional,
    forwardOnFailure,
    vb: `0 -34 ${width} ${height}`,
    pos,
    edges,
    route,
  };
}

/**
 * Карта статусов этапов route-задачи ИЗ РЕЕСТРА: после инициализации со скелетом
 * бандла реестр содержит ровно узлы маршрута, порядок ключей = порядок файла =
 * последовательность машины. Никаких захардкоженных списков этапов.
 */
export function routeStageKeys(registry: Record<string, string>): string[] {
  const STATUSES = new Set(['pending', 'running', 'done', 'waiting', 'skipped', 'failed']);
  const META = new Set(['WF_STATUS', 'NEEDS_RUN', 'STALLED_HUMAN']);
  return Object.entries(registry)
    .filter(([key, value]) => STATUSES.has(value)
      && /^[A-Z][A-Z0-9_]{1,63}$/.test(key)
      && !META.has(key)
      && !key.endsWith('_DECISION')
      && !key.endsWith('_AT'))
    .map(([key]) => key);
}
