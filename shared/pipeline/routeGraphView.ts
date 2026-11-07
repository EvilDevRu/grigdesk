// Схема маршрута для змейки FactoryGraph. Один построитель на три места: живой конвейер,
// опубликованная схема и холст редактора, поэтому редактор показывает ровно ту картинку,
// которую потом увидит человек у задачи.
//
// Узлы, ключи и переходы берутся из точных машин маршрута и разведки. Sequence задаёт
// только раскладку и не выдумывает переход к соседнему узлу. Данные и картинка разделены:
// `transitions` и `nodeOrigins` несут полную проекцию — каждый исход, остановки, статусы
// владельцев и выбор маршрута разведкой. Змейка (`pos`/`edges`) рисует исполняемые этапы
// и склеивает исходы одной пары в одну линию: служебные узлы и отдельная линия на каждый
// исход делали схему нечитаемой.
import { projectRouteMachine } from './routeProjection.ts';
import type { DraftMachine, RouteLoopDoc } from './routeDefinition.ts';
import type { ProjectedRouteEdge } from './routeProjection.ts';

// [вид, подпись, подзаголовок] узла схемы.
export type RouteGraphNode = [string, string, string];

// Переход маршрута: вперёд по `next`, назад по `rewind` либо остановка по `stop`.
export interface RouteTransition {
  next?: string;
  rewind?: string;
  stop?: string;
  reset?: string[];
  escalate?: { routes: string[] };
}

// Узел машины маршрута: у status вместо runKey бывает только key.
export interface RouteMachineNode {
  id: string;
  runKey?: string;
  key?: string;
  label?: string;
  executor?: string;
  owner?: string;
  emits?: string[];
  policy?: { filesystem?: string };
  on?: Record<string, RouteTransition | null | undefined>;
  onFailure?: Record<string, RouteTransition | null | undefined>;
}

// Машина маршрута: узлы и порядок раскладки (основная часть и хвост).
export interface RouteMachine {
  nodes?: RouteMachineNode[];
  sequence: { bootstrap?: string[]; main: string[]; tail: string[] };
  entry?: string;
  bootstrap?: 'required' | 'skip';
  loop?: RouteLoopDoc;
}

// Ребро схемы: откуда, куда, подпись, класс линии и способ прокладки.
export type RouteGraphEdge = [string, string, string, string, string];

// Откуда взят узел проекции. Нарисованы только этапы, песочница и, по запросу, выбор
// маршрута; status и остановки описаны здесь, но в змейку не попадают.
export interface RouteGraphNodeOrigin {
  scope: 'route' | 'bootstrap' | 'synthetic';
  originId: string | null;
  executable: boolean;
}

export interface RouteGraphTransition {
  source: string;
  target: string;
  channel: ProjectedRouteEdge['channel'];
  outcome: string;
  action: ProjectedRouteEdge['action'];
  reset: string[];
  kind: ProjectedRouteEdge['kind'];
}

// Форма графа совместима с graphForRoute (v1) и сохраняет семантические переходы.
export interface RouteGraphDef {
  nodes: Record<string, RouteGraphNode>;
  keys: Record<string, string>;
  runnerKeys: Record<string, string>;
  optional: string[];
  forwardOnFailure: string[];
  vb: string;
  pos: Record<string, [number, number]>;
  edges: RouteGraphEdge[];
  transitions: RouteGraphTransition[];
  nodeOrigins: Record<string, RouteGraphNodeOrigin>;
  route: string;
  loop: RouteLoopDoc | null;
}

export interface RouteGraphOptions {
  // `shared` убирает ромб песочницы: стенд там чужой и постоянный.
  workspaceMode?: string;
  // Разведка каталога, если маршрут её запускает.
  bootstrap?: RouteMachine;
  // Подпись узла без label; сервер берёт её из каталога стадий GrigDesk.
  labelOf?: (id: string) => string;
  // Как рисовать ромб песочницы.
  sandboxNode?: RouteGraphNode;
  // `minimal` не подписывает штатный ход вперёд, `all` перечисляет все исходы линии.
  outcomeLabels?: 'minimal' | 'all';
  // Выбор маршрута рисуется узлами: так разведка показывает, из чего выбирает.
  routeChoices?: boolean;
  // Подзаголовок узла — его ID в машине: редактору он нужен для переходов.
  nodeIds?: boolean;
}

type MachineScope = 'route' | 'bootstrap';
type DisplayId = (id: string, scope: MachineScope) => string;

// Этап змейки: его ID на схеме, пространство имён и узел машины.
interface VisualNode {
  id: string;
  scope: MachineScope;
  node: RouteMachineNode;
}

// Все исходы одной пары узлов, которые схема рисует одной линией.
interface EdgeGroup {
  source: string;
  target: string;
  rewind: boolean;
  normal: boolean;
  outcomes: string[];
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

// Вид узла на схеме по исполнителю машины.
const KIND: Record<string, string> = {
  agent: 'agent',
  gate: 'human',
  command: 'code',
};

// Штатный ход вперёд линия не подписывает, как и в v1: подпись «done» на каждом ребре
// перекрывала соседние подписи. Пропуск и провал вперёд подписываются.
const NORMAL_OUTCOMES = new Set(['done', 'approved']);
const CHOICE_PREFIX = 'catalog:route:';

/**
 * Переводит ID проекции в ID схемы: этапы получают свои короткие имена.
 * Этап разведки с именем этапа маршрута получает префикс, выбор текущего маршрута — entry.
 */
function displayIds(
  route: string,
  entry: string,
  routeNodes: ReadonlyMap<string, RouteMachineNode>,
  bootstrapNodes: ReadonlyMap<string, RouteMachineNode>,
): DisplayId {
  const routePrefix = `r:${route}:`;

  return (id, scope) => {
    if (scope === 'bootstrap' && id === `${CHOICE_PREFIX}${route}`) {
      return entry;
    }

    if (scope === 'route' && id.startsWith(routePrefix)) {
      const name = id.slice(routePrefix.length);

      return routeNodes.has(name) ? name : id;
    }

    if (scope === 'bootstrap' && id.startsWith('b:')) {
      const name = id.slice(2);

      if (!bootstrapNodes.has(name)) {
        return id;
      }

      return routeNodes.has(name) ? `bootstrap:${name}` : name;
    }

    return id;
  };
}

/**
 * Этапы змейки по порядку: разведка каталога, затем main и tail маршрута.
 * Status не исполняется, а остановка и выбор маршрута — исходы, поэтому их здесь нет.
 */
function visualNodes(
  machine: RouteMachine,
  bootstrap: RouteMachine | null,
  routeNodes: ReadonlyMap<string, RouteMachineNode>,
  bootstrapNodes: ReadonlyMap<string, RouteMachineNode>,
  displayId: DisplayId,
): VisualNode[] {
  const result: VisualNode[] = [];
  const seen = new Set<string>();

  const add = (id: string, scope: MachineScope) => {
    const node = (scope === 'bootstrap' ? bootstrapNodes : routeNodes).get(id);
    const visualId = scope === 'bootstrap' ? displayId(`b:${id}`, 'bootstrap') : id;

    if (!node || node.executor === 'status' || seen.has(visualId)) {
      return;
    }

    seen.add(visualId);
    result.push({
      id: visualId,
      scope,
      node,
    });
  };

  if (bootstrap) {
    for (const id of [...bootstrap.sequence.bootstrap ?? [], ...bootstrapNodes.keys()]) {
      add(id, 'bootstrap');
    }
  }

  // Узел вне sequence невалиден, но показываем и его: скрытый этап хуже заметного.
  for (const id of [...machine.sequence.main, ...machine.sequence.tail, ...routeNodes.keys()]) {
    add(id, 'route');
  }

  return result;
}

/**
 * Склеивает исполняемые переходы одной пары узлов в одну линию.
 * Переходы в остановку, status или неразвёрнутый маршрут остаются только в `transitions`.
 */
function edgeGroups(
  transitions: readonly RouteGraphTransition[],
  order: ReadonlyMap<string, number>,
): EdgeGroup[] {
  const groups = new Map<string, EdgeGroup>();

  for (const transition of transitions) {
    const drawable = transition.kind === 'execution'
      && order.has(transition.source)
      && order.has(transition.target);

    if (!drawable) {
      continue;
    }

    const rewind = transition.action === 'rewind';
    const key = [transition.source, transition.target, rewind].join('\u0000');
    const group = groups.get(key) ?? {
      source: transition.source,
      target: transition.target,
      rewind,
      normal: false,
      outcomes: [],
    };
    const outcome = transition.channel === 'onFailure'
      ? `failed:${transition.outcome}`
      : transition.outcome;

    group.outcomes.push(outcome);
    group.normal ||= transition.channel === 'on' && NORMAL_OUTCOMES.has(transition.outcome);
    groups.set(key, group);
  }

  return [...groups.values()];
}

/**
 * Прокладка линии между узлами с номерами `from` и `to` в змейке.
 * Соседи соединяются напрямую, стык рядов — вертикалью; пропуск вперёд и возврат
 * обходят ряд дугой (над первым рядом, под остальными), чтобы не идти сквозь узлы.
 */
function edgeRouting(from: number, to: number): string {
  const sourceRow = Math.floor(from / PER_ROW);
  const targetRow = Math.floor(to / PER_ROW);

  if (to === from + 1) {
    return sourceRow === targetRow ? 'h' : 'v';
  }

  return sourceRow === 0 && targetRow === 0 ? 'arc_up' : 'arc_down';
}

/**
 * Линии змейки: сначала ходы вперёд, затем возвраты от коротких к дальним,
 * чтобы соседние дуги занимали разные полосы. Возврат — класс `fail`, как в v1.
 */
function visualEdges(
  groups: readonly EdgeGroup[],
  order: ReadonlyMap<string, number>,
  outcomeLabels: 'minimal' | 'all',
): RouteGraphEdge[] {
  const indexOf = (id: string) => order.get(id) ?? 0;
  const distance = (group: EdgeGroup) => indexOf(group.source) - indexOf(group.target);
  const forward = groups
    .filter((group) => !group.rewind)
    .sort((left, right) => (
      indexOf(left.source) - indexOf(right.source) || indexOf(left.target) - indexOf(right.target)
    ));
  const rewinds = groups
    .filter((group) => group.rewind)
    .sort((left, right) => distance(left) - distance(right)
      || indexOf(left.source) - indexOf(right.source));
  const edges: RouteGraphEdge[] = forward.map((group) => [
    group.source,
    group.target,
    group.normal && outcomeLabels === 'minimal' ? '' : group.outcomes.join(' · '),
    'plain',
    edgeRouting(indexOf(group.source), indexOf(group.target)),
  ]);

  for (const group of rewinds) {
    edges.push([
      group.source,
      group.target,
      `✗ ${group.outcomes.join(' · ')}`,
      'fail',
      edgeRouting(indexOf(group.source), indexOf(group.target)),
    ]);
  }

  return edges;
}

/**
 * Проекции маршрута и разведки в ID схемы: все переходы и происхождение не нарисованных
 * узлов. Результат дополняет `nodeOrigins` и `transitions` вызывающего.
 */
function projectMachines(
  machine: RouteMachine,
  bootstrap: RouteMachine | null,
  route: string,
  entry: string,
  maps: {
    routeNodes: ReadonlyMap<string, RouteMachineNode>;
    bootstrapNodes: ReadonlyMap<string, RouteMachineNode>;
    displayId: DisplayId;
  },
  nodeOrigins: Record<string, RouteGraphNodeOrigin>,
  transitions: RouteGraphTransition[],
): void {
  const projections = [
    ...(bootstrap ? [{
      scope: 'bootstrap' as const,
      projection: projectRouteMachine(bootstrap as unknown as DraftMachine, { scope: 'bootstrap' }),
    }] : []),
    {
      scope: 'route' as const,
      projection: projectRouteMachine(machine as unknown as DraftMachine, {
        scope: 'route',
        routeId: route,
      }),
    },
  ];

  for (const { scope, projection } of projections) {
    for (const node of projection.nodes) {
      const id = maps.displayId(node.id, scope);
      const machineNode = node.origin.nodeId === null ? null
        : (scope === 'bootstrap' ? maps.bootstrapNodes : maps.routeNodes).get(node.origin.nodeId);

      // Выбор текущего маршрута — это переход к entry, а не отдельный узел.
      if (id in nodeOrigins || (node.origin.nodeId === null && id === entry)) {
        continue;
      }

      nodeOrigins[id] = {
        scope: machineNode ? scope : 'synthetic',
        originId: machineNode?.id ?? null,
        executable: false,
      };
    }

    for (const edge of projection.edges) {
      transitions.push({
        source: maps.displayId(edge.source, scope),
        target: maps.displayId(edge.target, scope),
        channel: edge.channel,
        outcome: edge.outcome,
        action: edge.action,
        reset: [...edge.reset],
        kind: edge.kind,
      });
    }
  }
}

/**
 * Строит форму графа по машине маршрута и, если передана, разведке его каталога.
 * Раскладка — змейка по sequence; линии — склеенные переходы машины, без выдуманных.
 */
export function buildRouteGraph(
  machine: RouteMachine,
  route: string,
  options: RouteGraphOptions = {},
): RouteGraphDef {
  const routeNodes = new Map((machine.nodes || []).map((node) => [node.id, node]));
  // При routeHash без каталога известна только машина маршрута. В этом случае
  // разведка не подставляется из current и не рисуется выдуманной цепочкой.
  const bootstrap = machine.bootstrap === 'skip' ? null : options.bootstrap ?? null;
  const bootstrapNodes = new Map((bootstrap?.nodes || []).map((node) => [node.id, node]));
  const entry = machine.entry ?? machine.sequence.main[0] ?? '';
  const displayId = displayIds(route, entry, routeNodes, bootstrapNodes);
  const stages = visualNodes(machine, bootstrap, routeNodes, bootstrapNodes, displayId);
  const labelOf = options.labelOf ?? ((id: string) => id);
  const nodes: Record<string, RouteGraphNode> = {};
  const keys: Record<string, string> = {};
  const nodeOrigins: Record<string, RouteGraphNodeOrigin> = {};
  const pos: Record<string, [number, number]> = {};
  const transitions: RouteGraphTransition[] = [];

  for (const item of stages) {
    // Подпись — из бандла, каталог стадий лишь запасной вариант для узла без label.
    nodes[item.id] = [
      KIND[String(item.node.executor)] || 'agent',
      item.node.label || labelOf(item.node.id),
      options.nodeIds ? item.node.id : '',
    ];
    keys[item.id] = item.node.runKey ?? item.node.key ?? '';
    nodeOrigins[item.id] = {
      scope: item.scope,
      originId: item.node.id,
      executable: true,
    };
  }

  projectMachines(machine, bootstrap, route, entry, {
    routeNodes,
    bootstrapNodes,
    displayId,
  }, nodeOrigins, transitions);

  // Выбор маршрута разведкой — исход, но редактору разведки нужно видеть, из чего она выбирает.
  const choices = options.routeChoices
    ? [...new Set(transitions
      .filter((edge) => edge.action === 'escalate' && edge.target.startsWith(CHOICE_PREFIX))
      .map((edge) => edge.target))]
    : [];

  for (const id of choices) {
    nodes[id] = ['code', id.slice(CHOICE_PREFIX.length), options.nodeIds ? 'маршрут' : ''];
  }

  const drawn = [...stages.map((item) => item.id), ...choices];
  const order = new Map(drawn.map((id, index) => [id, index]));

  drawn.forEach((id, index) => {
    const row = Math.floor(index / PER_ROW);
    const col = index % PER_ROW;

    // Нечётные ряды разворачиваем: конец ряда стыкуется с началом следующего.
    pos[id] = [
      X0 + (row % 2 === 0 ? col : PER_ROW - 1 - col) * CELL_W,
      Y0 + row * ROW_H,
    ];
  });

  // Песочница — ромб готовности стенда (статус даёт адаптер из tN.env). Стенд
  // поднимается ПАРАЛЛЕЛЬНО разведке: из стартовой точки две линии — в Scout и в
  // песочницу, а «стенд готов» приходит к первому узлу, которому нужна запись в
  // рабочее дерево (у v1 это tests). Узел ищем по политике бандла, без имён.
  // Shared-профилю рисовать ромб нельзя: песочницы там нет вовсе — стенд чужой,
  // постоянный и никем не поднимается, а lease/health происходят до старта разведки.
  const rows = Math.ceil(drawn.length / PER_ROW);
  const withSandbox = options.workspaceMode !== 'shared';
  const firstWriteId = machine.sequence.main.find((id) => {
    const policy = routeNodes.get(id)?.policy?.filesystem;

    return policy && policy !== 'state-only';
  }) || entry;
  const bootstrapEntry = bootstrap?.entry ? displayId(`b:${bootstrap.entry}`, 'bootstrap') : null;
  const startTarget = bootstrapEntry && order.has(bootstrapEntry) ? bootstrapEntry : entry;
  const startIndex = order.get(startTarget) ?? 0;
  // Вход не первым этапом змейки обходит ряд сверху, иначе линия прошла бы сквозь узлы.
  const startRouting = startIndex === 0 ? 'h' : startIndex < PER_ROW ? 'arc_up' : 'arc_down';
  // Незаконченный черновик может назвать входом удалённый этап или не иметь этапов вовсе:
  // линия к ненарисованному узлу уронила бы схему, а выдумывать вход нельзя.
  const edges: RouteGraphEdge[] = order.has(startTarget)
    ? [['_start', startTarget, '', 'plain', startRouting]]
    : [];

  if (withSandbox) {
    nodes.sandbox = options.sandboxNode ?? ['code', 'Песочница', ''];
    pos.sandbox = [X0 + Math.floor(PER_ROW / 2) * CELL_W, Y0 + Math.floor(ROW_H / 2)];
    nodeOrigins.sandbox = {
      scope: 'synthetic',
      originId: null,
      executable: false,
    };
    edges.push(['_start', 'sandbox', '', 'plain', 'to_sandbox']);

    if (order.has(firstWriteId)) {
      edges.push(['sandbox', firstWriteId, 'стенд готов', 'plain', 'from_sandbox']);
    }
  }

  edges.push(...visualEdges(edgeGroups(transitions, order), order, options.outcomeLabels ?? 'minimal'));

  const width = X0 + PER_ROW * CELL_W;
  const height = Y0 + (rows + 1) * ROW_H + 120;
  // Optional — свойство перехода машины, а не отдельная ручная карта UI.
  // skipped→stop означает аномалию/остановку; любой иной штатный переход
  // разрешает показывать skipped без skipbad и ложного premature на воротах.
  const optional = stages
    .filter(({ node }) => {
      const transition = node.on?.skipped;

      return transition
        && typeof transition === 'object'
        && !Object.hasOwn(transition, 'stop');
    })
    .map(({ id }) => id);

  // Узлы, чей провал по контракту ведёт маршрут ВПЕРЁД: член совета, у которого
  // кончилась квота провайдера, и ретро, чей отказ не отменяет публикацию. Реестр
  // пишет им `failed` (для exhausted — тоже), и без этого списка выпадение рисуется
  // красным «конвейер упёрся» — неотличимо от места, где маршрут действительно встал.
  // Rewind сюда не входит: возврат назад остановкой не является, но и пропуском тоже.
  const forwardOnFailure = stages
    .filter(({ node }) => node.executor !== 'gate' && ['failed', 'exhausted'].every((outcome) => {
      const transition = node.on?.[outcome];

      return transition
        && typeof transition === 'object'
        && typeof transition.next === 'string';
    }))
    .map(({ id }) => id);

  return {
    nodes,
    keys,
    runnerKeys: { ...keys },
    optional,
    forwardOnFailure,
    vb: `0 -34 ${width} ${height}`,
    pos,
    edges,
    transitions,
    nodeOrigins,
    route,
    loop: machine.loop && order.has(machine.loop.lead) && order.has(machine.loop.worker)
      ? { ...machine.loop }
      : null,
  };
}
