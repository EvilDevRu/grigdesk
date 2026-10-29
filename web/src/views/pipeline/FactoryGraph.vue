<template>
  <div class="graph-shell">
    <!-- Плашка обязана согласоваться с узлом: зелёный разбираемый узел под красным
         «конвейер встал» противоречил бы сам себе, и верили бы надписи. -->
    <div
      v-if="showStopBanner && stallView"
      class="graph-stop"
      :class="{ arb: arbitrating }"
      :role="arbitrating ? 'status' : 'alert'"
    >
      <span class="graph-stop-stage">{{ arbitrating ? '⚖' : '🛑' }} {{ stallView.nodeLabel }}</span>
      <strong>{{ arbitrating ? 'Арбитр разбирает остановку' : stallView.title }}</strong>
      <span
        v-if="arbitrating"
        class="graph-stop-fails mono"
      >{{ arbiterRunLabel(arbitrating) }}</span>
      <span
        v-else-if="stallView.fails != null"
        class="graph-stop-fails"
      >{{ stallView.fails }} сбоев</span>
      <span class="graph-stop-hint">{{
        arbitrating ? stallView.title : stallView.hint
      }}</span>
    </div>

    <div ref="viewport" class="graph-viewport"
         @pointerdown="initialPositioned = true" @wheel="initialPositioned = true">
      <svg
        class="graph"
        :viewBox="viewBox"
        :style="canvasStyle"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker
            :id="markerId"
            viewBox="0 0 8 8"
            refX="6.5"
            refY="4"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path class="arrowhead" d="M0,0 L8,4 L0,8 z" />
          </marker>
        </defs>

        <!-- старт -->
        <circle
          class="startdot"
          :cx="START_DOT[0]"
          :cy="START_DOT[1]"
          r="4"
        />

        <!-- рёбра -->
        <g class="edges">
          <g
            v-for="edge in edgeElements"
            :key="edge.key"
            :class="{ 'edge-muted': focusedNode && !edge.related, 'edge-related': edge.related }"
            v-tooltip="edge.visible ? edge.title : ''"
            :data-source="edge.source"
            :data-destination="edge.destination"
          >
            <path
              v-if="edge.visible"
              :d="edge.d"
              :class="edge.className"
              :marker-end="`url(#${markerId})`"
            />
            <text
              v-if="edge.visible && edge.label && edge.labelPosition && edge.showLabel"
              :x="edge.labelPosition[0]"
              :y="edge.labelPosition[1]"
              :class="edge.labelClass"
              text-anchor="middle"
            >
              {{ edge.label }}
            </text>
          </g>
        </g>

        <!-- узлы -->
        <component
          :is="nodeInteractive && node.executable ? UiSvgPressable : 'g'"
          v-for="node in nodeElements"
          :key="node.id"
          class="ng"
          :class="[
            `ns-${node.status}`,
            `nt-${node.kind}`,
            {
              clickable: nodeInteractive && node.executable,
              selected: node.id === selectedNode,
              'node-running': node.running,
              'loop-member': Boolean(node.loopRole),
              'loop-active': node.id === loop?.activeNode,
            },
          ]"
          :aria-current="node.id === selectedNode ? 'true' : undefined"
          :aria-label="nodeInteractive && node.executable ? node.label : undefined"
          :aria-description="nodeInteractive && node.executable ? node.description : undefined"
          v-tooltip="node.title"
          :data-node="node.id"
          @mouseenter="focusedNode = node.id"
          @mouseleave="focusedNode = null"
          @focusin="focusedNode = node.id"
          @focusout="focusedNode = null"
          @click="onNodeActivate(node, $event)"
        >
          <text
            v-if="node.loopRole"
            :x="node.cx"
            :y="node.top - 14"
            class="node-loop-role"
            text-anchor="middle"
          >{{ node.loopRole }}</text>
          <rect
            class="node-hit-area"
            :x="node.cx - node.halfWidth"
            :y="node.top - 4"
            :width="node.halfWidth * 2"
            :height="node.bottom - node.top + 4"
            aria-hidden="true"
          />
          <path
            v-if="node.kind === 'code'"
            class="node-shape"
            :d="node.shapePath"
          />
          <circle
            v-else
            class="node-shape"
            :cx="node.cx"
            :cy="node.cy"
            :r="node.radius"
          />
          <circle
            v-if="node.kind === 'human'"
            class="node-human-ring"
            :cx="node.cx"
            :cy="node.cy"
            :r="node.radius - 5"
            aria-hidden="true"
          />
          <path
            v-if="node.running && node.kind === 'code'"
            class="node-run-outline"
            :d="node.shapePath"
            pathLength="100"
            aria-hidden="true"
          />
          <circle
            v-else-if="node.running"
            class="node-run-outline"
            :cx="node.cx"
            :cy="node.cy"
            :r="node.radius"
            pathLength="100"
            aria-hidden="true"
          />
          <g
            class="node-kind"
            :transform="`translate(${node.cx - 8}, ${node.cy - 8})`"
            aria-hidden="true"
          >
            <path :d="node.icon" />
          </g>
          <circle
            v-if="node.mark"
            class="node-state-bg"
            :cx="node.cx + 16"
            :cy="node.cy + 16"
            r="8"
            aria-hidden="true"
          />
          <text
            v-if="node.mark"
            :x="node.cx + 16"
            :y="node.cy + 19.5"
            text-anchor="middle"
            class="node-state"
            aria-hidden="true"
          >
            <tspan class="mk" :class="`mk-${node.status}`" aria-hidden="true">{{ node.mark }}</tspan>
          </text>
          <text
            :x="node.contentX"
            :y="node.labelY"
            class="nlbl"
            text-anchor="middle"
          >
            <tspan
              v-for="(line, index) in node.labelLines"
              :key="index"
              :x="node.contentX"
              :dy="index ? 16 : 0"
            >{{ line }}</tspan>
          </text>
          <!-- След арбитра. Он не статус узла и живёт отдельной меткой: узел может быть
               уже пройден, а знать, кто двигал курсор, человеку всё равно нужно. -->
          <g
            v-if="node.arbiterVerdict"
            class="node-arb"
            :class="`node-arb-${node.arbiterVerdict}`"
            aria-hidden="true"
          >
            <rect
              class="node-arb-bg"
              :x="node.arbiterX - MARK_WIDTH / 2"
              :y="node.arbiterY - MARK_HEIGHT / 2"
              :width="MARK_WIDTH"
              :height="MARK_HEIGHT"
              :rx="MARK_HEIGHT / 2"
            />
            <text
              :x="node.arbiterX"
              :y="node.arbiterY + 3.5"
              text-anchor="middle"
              class="mk mk-arbiter"
            >⚖</text>
          </g>
          <foreignObject
            :x="node.cx - node.halfWidth + 8"
            :y="node.detailY"
            :width="node.halfWidth * 2 - 16"
            height="16"
          >
            <div
              xmlns="http://www.w3.org/1999/xhtml"
              class="node-detail"
              :class="[node.runner ? 'runner' : 'sub', { switched: node.runnerSwitched }]"
            >{{ node.detail }}</div>
          </foreignObject>
        </component>
      </svg>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId, nextTick, onMounted, onBeforeUnmount, watch } from 'vue';

import { UiSvgPressable, vTooltip } from '../../ui';
import {
  computeViewBox,
  edgePath,
  layoutGraphPositions,
  MARKS,
  nodeGeom,
  nodeLabelLines,
  START_DOT,
} from '../../shared/graphGeom.ts';
import { arbiterRunLabel, nodeIsArbitrated } from '../../shared/arbiterRun.ts';
import { graphStallView } from '../../shared/graphStall.ts';
import { factoryLoopView } from '../../shared/factoryLoopView.ts';
import {
  runnerChainLabel,
  runnerModelLabel,
  runnerNodeLabel,
} from '../../shared/runnerDisplay.ts';
import type {
  ArbiterRun,
  FactoryGraphData,
  GraphPosition,
  LabelPosition,
} from '../../../../shared/pipeline/factoryGraphContracts.ts';

interface GraphStall {
  node: string | null;
  nodeLabel: string;
  title: string;
  hint: string;
  fails: number | null;
}

interface EdgeElement {
  key: string;
  source: string;
  destination: string;
  title: string;
  d: string;
  className: string;
  label: string;
  labelPosition: LabelPosition;
  labelClass: string;
  visible: boolean;
  related: boolean;
  showLabel: boolean;
  bounds: GraphPosition[];
}

interface GraphNodeElement {
  id: string;
  originId: string | null;
  executable: boolean;
  kind: string | number;
  label: string;
  labelLines: string[];
  labelY: number;
  contentX: number;
  kindLabel: string | number;
  description: string;
  icon: string;
  statusLabel: string;
  detail: string;
  subtitle: string;
  cx: number;
  cy: number;
  halfWidth: number;
  halfHeight: number;
  radius: number;
  top: number;
  bottom: number;
  detailY: number;
  shapePath: string;
  status: string;
  running: boolean;
  runner: string;
  runnerModel: string;
  runnerSwitched: boolean;
  title: string;
  mark: string;
  arbiterVerdict: string;
  arbiterX: number;
  arbiterY: number;
  loopRole: string;
}

const props = withDefaults(
  defineProps<{
    graph: FactoryGraphData;
    loopsOn?: boolean;
    showStopBanner?: boolean;
    reference?: boolean;
    interactive?: boolean;
    // Идущий разбор — не свойство графа, а отдельный живой факт (`arbitrating` задачи в
    // `GET /api/tasks`). Данные движка он не подменяет: меняется только представление.
    arbitrating?: ArbiterRun | null;
    // Где арбитр УЖЕ отработал: узел → вердикт из истории попытки (`graph.arbiterLog`).
    // Идущий разбор виден статусом `arb` и гаснет вместе с ним, а этот след остаётся:
    // без него человек не знает, что курсор на узле двигал не он.
    arbitrated?: Record<string, string> | null;
    // Выбранный узел редактора маршрутов; живой конвейер выбора не держит.
    selectedNode?: string | null;
    highlightSelectedEdges?: boolean;
    // Масштаб холста относительно натурального размера, при котором текст читается.
    scale?: number;
  }>(),
  {
    loopsOn: false,
    showStopBanner: true,
    reference: false,
    interactive: false,
    arbitrating: null,
    arbitrated: null,
    selectedNode: null,
    highlightSelectedEdges: false,
    scale: 1,
  },
);

const emit = defineEmits<{
  node: [node: GraphNodeElement, event: MouseEvent | KeyboardEvent];
}>();

const viewport = ref<HTMLElement | null>(null);
const initialStageId = computed(() => {
  const statuses = Object.entries(props.graph.statuses ?? {});

  return statuses.find(([, status]) => status === 'run')?.[0]
    || statuses.find(([, status]) => ['wait', 'fail'].includes(status))?.[0];
});
let initialPositioned = false;
let viewportObserver: ResizeObserver | null = null;

/**
 * При первом показе живого графа открывает текущий этап в пределах его полосы.
 * После ручной прокрутки и обновлений данных положение остаётся у человека.
 */
function revealInitialStage(): void {
  const host = viewport.value;
  const current = initialStageId.value;

  if (props.reference || initialPositioned || !host?.clientWidth || !current) {
    return;
  }

  const node = Array.from(host.querySelectorAll<SVGElement>('[data-node]'))
    .find((element) => element.dataset.node === current);

  if (!node) {
    return;
  }

  const bounds = host.getBoundingClientRect();
  const target = node.getBoundingClientRect();

  host.scrollLeft += target.left + target.width / 2 - bounds.left - bounds.width / 2;
  initialPositioned = true;
}

watch(() => initialStageId.value, () => {
  void nextTick(revealInitialStage);
});

onMounted(() => {
  revealInitialStage();

  if (typeof ResizeObserver !== 'undefined' && viewport.value) {
    viewportObserver = new ResizeObserver(revealInitialStage);
    viewportObserver.observe(viewport.value);
  }
});

onBeforeUnmount(() => viewportObserver?.disconnect());

const markerId = `graph-arrow-${useId()}`;
const focusedNode = ref<string | null>(null);
const relatedNode = computed(() => focusedNode.value
  ?? (props.highlightSelectedEdges ? props.selectedNode : null));

// Пройденный узел рисуется одинаково и когда он сделан, и когда законно пропущен.
// Множество строк, а не статусов: неизвестного узла в карте статусов может не быть
// вовсе, и такое отсутствие означает «ещё не дошли», а не ошибку.
const doneLike = new Set<string | undefined>(['done', 'skip']);
// Подсказка следа арбитра. Вердикты те же, что в `lib/arbiter-cards.js`; незнакомый
// вердикт метки не даёт вовсе — выдумывать за сервер смысл нельзя.
const ARBITER_NODE_TITLE: Record<string, string> = {
  human: 'Арбитр разобрал эту остановку и вернул решение тебе — открой узел',
  resolve: 'Арбитр снял здесь тупик и вернул конвейер сам',
  deferred: 'Арбитр выбрал минимальный вариант за тебя — проверишь на воротах',
};
const statusMarks = MARKS as Record<string, string>;
// Пилюля следа арбитра над узлом.
const MARK_WIDTH = 24;
const MARK_HEIGHT = 14;
const KIND_LABEL: Record<string, string> = {
  agent: 'Агент',
  code: 'Автоматически',
  human: 'Решение человека',
};
const KIND_HEADING: Record<string, string> = {
  agent: 'Агент',
  code: 'Проверка',
  human: 'Человек',
};
// Значки дополняют силуэт типа, а цвет состояния остаётся самостоятельным сигналом.
// Все контуры нарисованы в одной сетке 16 × 16.
const KIND_ICON: Record<string, string> = {
  agent: 'M8 1.5 9.8 6.2 14.5 8 9.8 9.8 8 14.5 6.2 9.8 1.5 8 6.2 6.2Z',
  code: 'M4 3 1 8 4 13 M12 3 15 8 12 13 M6 8 7.5 9.5 10.5 6',
  human: 'M10.5 4.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0 M3 14v-2a5 3 0 0 1 10 0v2',
};
const STATUS_LABEL: Record<string, string> = {
  done: 'Готово',
  run: 'В работе',
  wait: 'Ждёт тебя',
  stall: 'Остановка',
  skipbad: 'Аномалия',
  premature: 'Раньше срока',
  fail: 'Ошибка',
  arb: 'Разбор',
  skip: 'Пропущен',
  idle: 'Нет данных',
  pending: 'Не начат',
};

const nodeInteractive = computed(() => props.interactive || !props.reference);
const loop = computed(() => factoryLoopView(props.graph, props.reference));

/**
 * Статус run переживает остановку демона, поэтому сам по себе не включает движение.
 * Обводка и входящие стрелки используют один признак живой работы на любом маршруте.
 */
const runningNodes = computed(() => {
  if (props.reference || props.graph.daemonAlive !== true || props.graph.stall) {
    return new Set<string>();
  }

  return new Set(Object.entries(props.graph.statuses ?? {})
    .filter(([, status]) => status === 'run')
    .map(([id]) => id));
});

const activeReturnNodes = computed(() => new Set(props.graph.edges
  .filter(([source, destination, , kind]) => (
    kind === 'fail' && (props.graph.loops?.[source] ?? 0) > 0 && runningNodes.value.has(destination)
  ))
  .map(([, destination]) => destination)));

const parallelNodes = computed(() => props.graph.edges
  .filter(([, , , , routing]) => routing === 'to_sandbox')
  .map(([, destination]) => destination));
const stallView = computed<GraphStall | null>(() => {
  if (props.reference) {
    return null;
  }

  return graphStallView(props.graph) as GraphStall | null;
});
const positions = computed<Record<string, GraphPosition>>(() => layoutGraphPositions(
  props.graph.pos,
  props.graph.nodes,
  props.graph.edges.some(([source, , , kind]) => (
    kind === 'fail'
      && (loop.value || props.reference || props.loopsOn || (props.graph.loops?.[source] ?? 0) > 0)
  )),
  parallelNodes.value,
));

/**
 * Возвраты обычного маршрута скрыты до первого прохода или включения переключателя.
 * Пара режима петли всегда показывает обе передачи, но движется только вход в работающий узел.
 */
const edgeElements = computed<EdgeElement[]>(() => {
  const graph = props.graph;
  const statuses = graph.statuses ?? {};
  const elements: EdgeElement[] = [];

  for (const [index, [source, destination, originalLabel, edgeClass, routing]] of graph.edges.entries()) {
    const cycle = loop.value;
    const transfer = cycle && source === cycle.lead && destination === cycle.worker;
    const review = cycle && source === cycle.worker && destination === cycle.lead;
    const cycleEdge = Boolean(transfer || review);
    const path = edgePath(
      source,
      destination,
      routing,
      positions.value,
      graph.nodes,
      transfer ? 2 : index,
    ) as {
      d: string;
      label: LabelPosition;
      bounds: GraphPosition[];
    };
    let className = 'e-off';
    let label = originalLabel;
    let visible = true;
    let labelClass = 'elbl';

    if (cycleEdge) {
      className = 'e-cycle';
      label = transfer ? 'Задание на круг' : 'На проверку';
      labelClass = 'elbl-cycle';

      // На первом входе ведущий ещё не получил результат исполнителя.
      // После передачи круг уже положительный, даже если статусы пары сброшены в pending.
      if (cycle?.activeNode === destination && (transfer || (cycle.round ?? 0) > 0)) {
        className += ' e-flow';
      }
    } else if (edgeClass === 'fail') {
      if (props.reference) {
        className = 'e-fail';
        labelClass = 'elbl-fail';
      } else {
        const loopCount = graph.loops?.[source] ?? 0;

        className = loopCount > 0 ? 'e-loop' : 'e-fail';

        if (loopCount > 0 && runningNodes.value.has(destination)) {
          className += ' e-flow';
        }

        label = loopCount > 0 ? `${originalLabel} ×${loopCount}` : originalLabel;
        visible = props.loopsOn || loopCount > 0;
        labelClass = 'elbl-fail';
      }
    } else if (props.reference) {
      className = 'e-on';
      labelClass = edgeClass === 'pass' ? 'elbl-pass' : 'elbl';
    } else {
      const sourceStatus = source === '_start' ? 'done' : statuses[source];
      const destinationStatus = statuses[destination];

      if (doneLike.has(sourceStatus) && runningNodes.value.has(destination)
        && !activeReturnNodes.value.has(destination)) {
        className = 'e-flow';
      } else if (doneLike.has(sourceStatus) && destinationStatus && destinationStatus !== 'pending') {
        className = 'e-on';
      }

      labelClass = edgeClass === 'pass' ? 'elbl-pass' : 'elbl';
    }

    // Вход в маршрут и возврат с ворот не должны двигаться одновременно с передачей пары.
    // На паузе старый run в реестре также не является свидетельством живой работы.
    if (cycle && !props.reference && !cycleEdge
      && (!cycle.activeNode || (cycle.round ?? 0) > 0)
      && [cycle.lead, cycle.worker].includes(destination)) {
      className = className.replace('e-flow', 'e-on');
    }

    elements.push({
      key: `${source}-${destination}-${index}`,
      source,
      destination,
      title: [
        `${graph.nodes[source]?.[1] || 'Старт'} → ${graph.nodes[destination]?.[1] || destination}`,
        label,
        cycleEdge ? originalLabel : '',
      ].filter(Boolean).join(' · '),
      d: path.d,
      className,
      label,
      labelPosition: path.label,
      labelClass,
      visible,
      related: relatedNode.value === source || relatedNode.value === destination,
      showLabel: cycleEdge || edgeClass !== 'fail' || focusedNode.value === source,
      bounds: path.bounds,
    });
  }

  return elements;
});

const viewBox = computed(() => computeViewBox(
  positions.value,
  props.graph.nodes,
  edgeElements.value.filter((edge) => edge.visible).map((edge) => ({
    bounds: edge.bounds,
    label: edge.label ? edge.labelPosition : null,
    labelText: edge.label,
  })),
));
const canvasStyle = computed(() => {
  const width = Number(viewBox.value.split(' ')[2]) * props.scale;

  return {
    minWidth: `${width}px`,
    maxWidth: `${width}px`,
  };
});

/**
 * Ромб обозначает автоматический шаг; его вершины совпадают с точками подключения связей.
 * Текст находится снаружи, поэтому длинное название не растягивает сам значок.
 */
function codeNodePath(geometry: ReturnType<typeof nodeGeom>): string {
  const { cx, cy, radius } = geometry;

  return [
    `M ${cx} ${cy - radius}`,
    `L ${cx + radius} ${cy}`,
    `L ${cx} ${cy + radius}`,
    `L ${cx - radius} ${cy} Z`,
  ].join(' ');
}

/**
 * Сервер отдаёт компактные tuples, а шаблону нужны готовые геометрия, подписи
 * раннера и состояние остановки. Нормализация здесь удерживает SVG декларативным.
 */
const nodeElements = computed<GraphNodeElement[]>(() => {
  const graph = props.graph;

  // Порядок фокуса следует серверной цепочке, даже когда второй ряд идёт справа налево.
  return Object.keys(graph.pos).map((nodeId) => {
    const definition = graph.nodes[nodeId] ?? ['agent', nodeId, ''];
    const origin = graph.nodeOrigins?.[nodeId];
    const kind = definition[0];
    const label = definition[1] || nodeId;
    const subtitle = definition[2] || '';
    const geometry = nodeGeom(nodeId, positions.value, graph.nodes);
    const labelLines = nodeLabelLines(label);
    const labelY = geometry.labelY;
    const committed = props.reference
      ? 'ref'
      : (graph.statuses?.[nodeId] ?? 'pending');
    // Пока идёт разбор, узел остановки перестаёт быть тревогой: работа не стоит на
    // человеке, её прямо сейчас делает арбитр. Красный узел в это время звал бы к
    // курьерской работе, которую он и снимает.
    const status = nodeIsArbitrated(committed, props.arbitrating) ? 'arb' : committed;
    const kindLabel = parallelNodes.value.includes(nodeId) ? 'Стенд' : KIND_HEADING[kind] || kind;
    const statusLabel = STATUS_LABEL[status] || '';
    const loopRole = loop.value?.lead === nodeId
      ? 'Ведущий' : loop.value?.worker === nodeId ? 'Исполнитель' : '';
    const description = [kindLabel, loopRole, statusLabel].filter(Boolean).join(' · ');
    const runnerMetadata = graph.nodeMeta?.[nodeId]?.runner ?? null;
    const runner = runnerMetadata ? runnerNodeLabel(runnerMetadata) : '';
    const runnerModel = runnerMetadata ? runnerModelLabel(runnerMetadata) : '';
    const detail = runner
      ? [runner, runnerModel].filter(Boolean).join(' · ')
      : subtitle || KIND_LABEL[kind] || '';
    const nodeStall = stallView.value?.node === nodeId ? stallView.value : null;
    const arbitratedReason = nodeStall?.title || 'узел остановил маршрут';
    const stallTitle = status === 'arb'
      ? `Арбитр разбирает остановку (${arbiterRunLabel(props.arbitrating)}) — ${arbitratedReason}`
      : (nodeStall
        ? `${nodeStall.title}${nodeStall.hint ? ` — ${nodeStall.hint}` : ''}`
        : '');
    const runnerTitle = runnerMetadata
      ? `${runnerChainLabel(runnerMetadata)}${runnerModel ? ` · модель ${runnerModel}` : ''}`
      : '';
    const arbiterVerdict = props.reference ? '' : (props.arbitrated?.[nodeId] ?? '');
    const arbiterTitle = arbiterVerdict ? ARBITER_NODE_TITLE[arbiterVerdict] ?? '' : '';

    return {
      id: nodeId,
      originId: origin?.originId ?? nodeId,
      executable: origin?.executable ?? nodeId !== 'sandbox',
      kind,
      label,
      labelLines,
      labelY,
      contentX: geometry.cx,
      kindLabel,
      loopRole,
      description,
      icon: KIND_ICON[kind] || '',
      statusLabel,
      detail,
      subtitle,
      cx: geometry.cx,
      cy: geometry.cy,
      halfWidth: geometry.hw,
      halfHeight: geometry.hh,
      radius: geometry.radius,
      top: geometry.top,
      bottom: geometry.bottom,
      detailY: geometry.detailY,
      shapePath: kind === 'code' ? codeNodePath(geometry) : '',
      status,
      running: runningNodes.value.has(nodeId),
      runner,
      runnerModel,
      runnerSwitched: Boolean(runnerMetadata?.switched),
      title: [label, description, stallTitle, arbiterTitle, runnerTitle, subtitle].filter(Boolean).join('\n'),
      mark: status === 'run' ? '' : statusMarks[status] ?? '',
      arbiterVerdict,
      // След арбитра остаётся над значком, отдельно от текущего статуса.
      // Размер холста учитывает метку, поэтому у верхнего ряда она не обрезается.
      arbiterX: geometry.cx - geometry.radius,
      arbiterY: geometry.top - 8,
    };
  });
});

function onNodeActivate(
  node: GraphNodeElement,
  event: MouseEvent | KeyboardEvent,
): void {
  if (!nodeInteractive.value || !node.executable) {
    return;
  }

  emit('node', node, event);
}
</script>

<style scoped>
.graph-shell { width: 100%; }
.graph-stop { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: baseline;
  gap: 4px 10px; margin: 2px 0 8px; padding: 8px 11px; color: var(--bad);
  background: color-mix(in srgb, var(--bad) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--bad) 38%, transparent); border-radius: 8px;
  font-size: 12px; line-height: 1.35; }
.graph-stop-stage { font-weight: 700; white-space: nowrap; }
.graph-stop strong { font-weight: 650; }
.graph-stop-fails { white-space: nowrap; font-family: var(--mono); opacity: .85; }
.graph-stop-hint { grid-column: 2 / -1; color: var(--ink-mid); }
/* Плашка называет идущий разбор спокойным зелёным; движение остаётся у самого узла. */
.graph-stop.arb { color: var(--good);
  background: color-mix(in srgb, var(--good) 12%, transparent);
  border-color: color-mix(in srgb, var(--good) 38%, transparent); }
.graph-viewport {
  overflow-x: auto;
  padding: 4px 0;
  scrollbar-color: var(--line-2) transparent;
  scrollbar-width: thin;
}
.graph {
  display: block;
  width: 100%;
  height: auto;
  /* Auto-поля центрируют короткую схему и обнуляются, когда нужна прокрутка. */
  margin: 0 auto;
}
/* Каждый граф владеет своим marker, а цвет стрелки наследуется от линии. */
.arrowhead { fill: context-stroke; }
.startdot { fill: var(--ink-mid); }

.ng {
  --node-tone: var(--node-agent);
  --node-state: var(--ink-mid);
}
.nt-human { --node-tone: var(--node-human); }
.nt-code { --node-tone: var(--node-code); }
.node-shape {
  fill: color-mix(in srgb, var(--node-tone) 10%, var(--surface));
  stroke: color-mix(in srgb, var(--node-tone) 72%, var(--line-2));
  stroke-width: 1;
  stroke-linejoin: round;
  transition: fill 160ms ease, stroke 160ms ease;
}
.clickable { cursor: pointer; }
.clickable.ns-pending:hover .node-shape, .clickable.ns-ref:hover .node-shape {
  stroke: color-mix(in srgb, var(--node-tone) 90%, var(--ink));
  fill: color-mix(in srgb, var(--node-tone) 12%, var(--surface));
}
.node-hit-area { fill: transparent; }
/* Выбор в редакторе — толщина и акцент контура, а не цвет статуса: статуса там нет. */
.selected .node-shape {
  stroke: var(--accent);
  stroke-width: 3;
}
.node-human-ring { fill: none; stroke: var(--node-tone); opacity: .4; }
.node-kind { color: var(--node-tone); }
.node-kind path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.25;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.node-state-bg { fill: var(--surface); stroke: var(--node-state); stroke-width: 1; }
.node-state {
  fill: var(--node-state);
  font: 10px var(--sans);
}
.node-loop-role {
  fill: var(--ink-mid);
  font: 10px var(--sans);
  paint-order: stroke;
  stroke: var(--surface);
  stroke-width: 4px;
}
.loop-active .node-loop-role { fill: var(--accent); }
.node-run-outline {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 25 75;
  animation: node-run-spin .85s linear infinite;
  pointer-events: none;
}
.nlbl {
  fill: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
  font-family: var(--sans);
}
.node-detail {
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 10.5px;
  font-family: var(--sans);
  line-height: 16px;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: center;
}
.node-detail.runner.switched { color: var(--warn); }
.node-arb-bg { fill: color-mix(in srgb, currentColor 18%, var(--surface)); }
.node-arb-human { color: var(--warn); }
.node-arb-resolve, .node-arb-deferred { color: var(--ink-mid); }
.mk {
  fill: var(--node-state);
  font-size: 10px;
  font-family: var(--sans);
  font-weight: 750;
  pointer-events: none;
}
.mk-done, .mk-arb { fill: var(--good); }
.mk-wait { fill: var(--warn); }
.mk-stall, .mk-skipbad, .mk-premature, .mk-fail { fill: var(--bad); }
.mk-arbiter { fill: currentColor; }

/* Знак статуса примыкает к значку; контур выделяет этап, которому нужно внимание. */
.ns-pending .nlbl { fill: color-mix(in srgb, var(--ink) 88%, var(--ink-mid)); }
.ns-done { --node-state: var(--good); }
.ns-done .node-shape {
  stroke: color-mix(in srgb, var(--good) 72%, var(--line-2));
}
.ns-idle .node-shape { stroke-dasharray: 6 4; }
.ns-skip .node-shape { stroke-dasharray: 4 4; }
.ns-skip .nlbl { fill: var(--ink-mid); }
.ns-run { --node-state: var(--accent); }
.ns-run .node-shape {
  stroke: var(--accent);
  stroke-width: 1.5;
  fill: color-mix(in srgb, var(--accent) 9%, var(--surface));
}
.ns-run .node-detail { color: color-mix(in srgb, var(--accent) 75%, var(--ink)); }
.node-running .node-shape { stroke: color-mix(in srgb, var(--accent) 30%, var(--line-2)); }
.ns-wait { --node-state: var(--warn); }
.ns-wait .node-shape {
  stroke: var(--warn);
  stroke-width: 1.5;
  fill: color-mix(in srgb, var(--warn) 6%, var(--surface));
}
.ns-stall, .ns-premature, .ns-fail, .ns-skipbad { --node-state: var(--bad); }
.ns-stall .node-shape, .ns-premature .node-shape, .ns-fail .node-shape, .ns-skipbad .node-shape {
  stroke: var(--bad);
  stroke-width: 1.5;
  fill: color-mix(in srgb, var(--bad) 6%, var(--surface));
}
.ns-skipbad .node-shape { stroke-dasharray: 5 4; }
/* Разбор отличается от завершённого шага насыщенной рамкой и движением. */
.ns-arb { --node-state: var(--good); }
.ns-arb .node-shape {
  stroke: var(--good);
  stroke-width: 1.5;
  fill: color-mix(in srgb, var(--good) 9%, var(--surface));
}
.ns-arb .mk-arb { animation: nodepulse 2.4s ease-in-out infinite; }

.edges path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.edges > g { transition: opacity 160ms ease; }
.e-off { stroke: var(--idle); stroke-width: 1.3; }
.e-on { stroke: var(--edge-on); opacity: .55; stroke-width: 1.5; }
.e-flow {
  stroke: var(--accent);
  stroke-width: 1.8;
  stroke-dasharray: 6 6;
  animation: flow 1s linear infinite;
}
.e-fail { stroke: var(--ink-low); opacity: .45; stroke-width: 1.2; stroke-dasharray: 4 5; }
.e-loop { stroke: var(--bad); opacity: .85; stroke-width: 1.8; }
.e-loop.e-flow { stroke: var(--accent); opacity: 1; stroke-width: 2.4; stroke-dasharray: 6 6; }
.e-cycle { stroke: var(--accent); opacity: .6; stroke-width: 2; }
.e-cycle.e-flow { opacity: 1; stroke-width: 2.4; }
.edge-muted { opacity: .18; }
.edge-related .e-fail { stroke: var(--warn); opacity: .9; }
.elbl, .elbl-pass, .elbl-fail, .elbl-cycle {
  fill: var(--ink-mid);
  font-size: 10px;
  font-family: var(--sans);
  paint-order: stroke;
  stroke: var(--ground);
  stroke-width: 4px;
  stroke-linejoin: round;
  pointer-events: none;
}
.elbl-pass { fill: var(--good); }
.elbl-fail { fill: var(--warn); }
.elbl-cycle { fill: var(--accent); font-weight: 600; }

@keyframes nodepulse { 50% { opacity: .4; } }
@keyframes flow { to { stroke-dashoffset: -12; } }
@keyframes node-run-spin { to { stroke-dashoffset: -100; } }
@media (prefers-reduced-motion: reduce) {
  .edges > g, .node-shape { transition: none; }
  .e-flow, .node-run-outline, .ns-arb .mk-arb, .graph-stop.arb {
    animation: none;
  }
}
@media (max-width: 720px) {
  .graph-stop { grid-template-columns: 1fr auto; }
  .graph-stop strong, .graph-stop-hint { grid-column: 1 / -1; }
}
</style>
