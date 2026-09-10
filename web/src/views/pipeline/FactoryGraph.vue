<template>
  <div class="graph-shell">
    <!-- Плашка обязана согласоваться с узлом: зелёный разбираемый узел под красным
         «конвейер встал» противоречил бы сам себе, и верили бы надписи. -->
    <div
      v-if="stallView"
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

    <svg
      class="graph"
      :viewBox="viewBox"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <marker
          id="arr"
          viewBox="0 0 8 8"
          refX="6.5"
          refY="4"
          markerWidth="6.5"
          markerHeight="6.5"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 z" />
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
        <template
          v-for="edge in edgeElements"
          :key="edge.key"
        >
          <path
            v-if="edge.visible"
            :d="edge.d"
            :class="edge.className"
            marker-end="url(#arr)"
          />
          <text
            v-if="edge.visible && edge.label && edge.labelPosition"
            :x="edge.labelPosition[0]"
            :y="edge.labelPosition[1]"
            :class="edge.labelClass"
            text-anchor="middle"
          >
            {{ edge.label }}
          </text>
        </template>
      </g>

      <!-- узлы -->
      <component
        :is="nodeElement"
        v-for="node in nodeElements"
        :key="node.id"
        class="ng"
        :class="[
          `ns-${node.status}`,
          `nt-${node.kind}`,
          { clickable: nodeInteractive },
        ]"
        :aria-label="nodeInteractive ? node.label : undefined"
        @click="onNodeActivate(node, $event)"
      >
        <title v-if="node.title">{{ node.title }}</title>
        <polygon
          v-if="node.points"
          :points="node.points"
        />
        <rect
          v-else
          :x="node.cx - node.halfWidth"
          :y="node.cy - node.halfHeight"
          :width="node.halfWidth * 2"
          :height="node.halfHeight * 2"
          :rx="node.radius"
        />
        <text
          :x="node.cx"
          :y="node.cy + 4"
          text-anchor="middle"
          class="nlbl"
        >
          {{ node.label }}
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
        <text
          v-if="node.mark"
          :x="node.markX"
          :y="node.markY"
          text-anchor="middle"
          class="mk"
          :class="`mk-${node.status}`"
          aria-hidden="true"
        >{{ node.mark }}</text>
        <text
          v-if="node.subtitle"
          :x="node.cx"
          :y="node.subtitleY"
          text-anchor="middle"
          class="sub"
        >
          {{ node.subtitle }}
        </text>
        <text
          v-if="node.runner"
          :x="node.cx"
          :y="node.runnerY"
          text-anchor="middle"
          class="runner"
          :class="{ switched: node.runnerSwitched }"
        >
          {{ node.runner }}<tspan v-if="node.runnerModel"> · {{ node.runnerModel }}</tspan>
        </text>
      </component>
    </svg>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiSvgPressable } from '../../ui';
import {
  computeViewBox,
  edgePath,
  MARKS,
  nodeGeom,
  START_DOT,
} from '../../shared/graph-geom.js';
import { arbiterRunLabel, nodeIsArbitrated } from '../../shared/arbiter-run.js';
import { graphStallView } from '../../shared/graph-stall.js';
import {
  runnerChainLabel,
  runnerModelLabel,
  runnerNodeLabel,
} from '../../shared/runnerDisplay.ts';
import type {
  ArbiterRun,
  FactoryGraphData,
  GraphNodeDefinition,
  GraphPosition,
  LabelPosition,
} from '../../../../shared/factoryGraphContracts.ts';

interface GraphStall {
  node: string | null;
  nodeLabel: string;
  title: string;
  hint: string;
  fails: number | null;
}

interface EdgeElement {
  key: string;
  d: string;
  className: string;
  label: string;
  labelPosition: LabelPosition;
  labelClass: string;
  visible: boolean;
}

interface GraphNodeElement {
  id: string;
  kind: string;
  label: string;
  subtitle: string;
  cx: number;
  cy: number;
  halfWidth: number;
  halfHeight: number;
  radius: number;
  points: string | null;
  status: string;
  runner: string;
  runnerModel: string;
  runnerSwitched: boolean;
  title: string;
  mark: string;
  markX: number;
  markY: number;
  arbiterVerdict: string;
  arbiterX: number;
  arbiterY: number;
  subtitleY: number;
  runnerY: number;
}

const props = withDefaults(
  defineProps<{
    graph: FactoryGraphData;
    loopsOn?: boolean;
    reference?: boolean;
    interactive?: boolean;
    // Идущий разбор — не свойство графа, а отдельный живой факт (`arbitrating` задачи в
    // `GET /api/tasks`). Данные движка он не подменяет: меняется только представление.
    arbitrating?: ArbiterRun | null;
    // Где арбитр УЖЕ отработал: узел → вердикт из истории попытки (`graph.arbiterLog`).
    // Идущий разбор виден статусом `arb` и гаснет вместе с ним, а этот след остаётся:
    // без него человек не знает, что курсор на узле двигал не он.
    arbitrated?: Record<string, string> | null;
  }>(),
  {
    loopsOn: false,
    reference: false,
    interactive: false,
    arbitrating: null,
    arbitrated: null,
  },
);

const emit = defineEmits<{
  node: [node: GraphNodeElement, event: MouseEvent | KeyboardEvent];
}>();

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
// Ширину подписи SVG не сообщает, а знак статуса надо поставить сразу за ней. Оценка
// снята замером 11px system-ui в Chrome: 6.6–7.5 px на символ кириллицы. Берём верхнюю
// границу — ошибка вверх лишь отодвигает знак от подписи, ошибка вниз даёт наезд.
const LABEL_CHAR_WIDTH = 7.4;
const MARK_GAP = 8;
const MARK_DIAMOND_BASELINE = 13;
const nodeInteractive = computed(() => props.interactive || !props.reference);
const nodeElement = computed(() => (nodeInteractive.value ? UiSvgPressable : 'g'));
const stallView = computed<GraphStall | null>(() => {
  if (props.reference) {
    return null;
  }

  return graphStallView(props.graph) as GraphStall | null;
});
const viewBox = computed(() => computeViewBox(props.graph.pos, props.graph.nodes));

/**
 * Fail-рёбра зависят не только от статуса источника: потенциальные циклы скрыты,
 * пока пользователь не включит их или сервер не зафиксирует фактический проход.
 */
const edgeElements = computed<EdgeElement[]>(() => {
  const graph = props.graph;
  const statuses = graph.statuses ?? {};
  const elements: EdgeElement[] = [];

  for (const [source, destination, originalLabel, edgeClass, routing] of graph.edges) {
    const path = edgePath(
      source,
      destination,
      routing,
      graph.pos,
      graph.nodes,
    ) as { d: string; label: LabelPosition };
    let className = 'e-off';
    let label = originalLabel;
    let visible = true;
    let labelClass = 'elbl';

    if (edgeClass === 'fail') {
      if (props.reference) {
        className = 'e-fail';
        labelClass = 'elbl-fail';
      } else {
        const loopCount = graph.loops?.[source] ?? 0;

        className = loopCount > 0 ? 'e-loop' : 'e-fail';

        if (loopCount > 0 && statuses[destination] === 'run') {
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

      className = doneLike.has(sourceStatus)
        ? 'e-on'
        : sourceStatus === 'run'
          ? 'e-flow'
          : 'e-off';
      labelClass = edgeClass === 'pass' ? 'elbl-pass' : 'elbl';
    }

    elements.push({
      key: `${source}-${destination}`,
      d: path.d,
      className,
      label,
      labelPosition: path.label,
      labelClass,
      visible,
    });
  }

  return elements;
});

interface NodeGeometry {
  cx: number;
  cy: number;
  hw: number;
}

interface MarkPlacement {
  x: number;
  y: number;
}

/**
 * Место знака статуса. Он стоит отдельным элементом, а не хвостом подписи: внутри
 * общего `<text>` знак центрировался вместе с названием и двигал его при каждой смене
 * статуса. Позиция считается от оценённой ширины подписи, поэтому знак читается как
 * часть названия и не превращается в отдельную наклейку у рамки.
 *
 * У ромба справа сходятся грани: там, где у прямоугольника есть место, у него остаются
 * единицы пикселей высоты, и знак садился прямо на контур. Поэтому ромбу знак ставится
 * под названием — по центру, где высота максимальна.
 */
function markPlacement(
  kind: string,
  label: string,
  geometry: NodeGeometry,
): MarkPlacement {
  if (kind === 'code') {
    return { x: geometry.cx, y: geometry.cy + MARK_DIAMOND_BASELINE };
  }

  const labelHalfWidth = ([...label].length * LABEL_CHAR_WIDTH) / 2;

  return {
    x: Math.min(geometry.cx + labelHalfWidth + MARK_GAP, geometry.cx + geometry.hw - 10),
    y: geometry.cy + 3.5,
  };
}

/**
 * Сервер отдаёт компактные tuples, а шаблону нужны готовые геометрия, подписи
 * раннера и состояние остановки. Нормализация здесь удерживает SVG декларативным.
 */
const nodeElements = computed<GraphNodeElement[]>(() => {
  const graph = props.graph;

  return Object.keys(graph.pos).map((nodeId) => {
    const definition = graph.nodes[nodeId] ?? ['agent', nodeId, ''];
    const kind = definition[0];
    const label = definition[1] || nodeId;
    const subtitle = definition[2] || '';
    const geometry = nodeGeom(nodeId, graph.pos, graph.nodes);
    const committed = props.reference
      ? 'ref'
      : (graph.statuses?.[nodeId] ?? 'pending');
    // Пока идёт разбор, узел остановки перестаёт быть тревогой: работа не стоит на
    // человеке, её прямо сейчас делает арбитр. Красный узел в это время звал бы к
    // курьерской работе, которую он и снимает.
    const status = nodeIsArbitrated(committed, props.arbitrating) ? 'arb' : committed;
    const runnerMetadata = graph.nodeMeta?.[nodeId]?.runner ?? null;
    const runner = runnerMetadata ? runnerNodeLabel(runnerMetadata) : '';
    const runnerModel = runnerMetadata ? runnerModelLabel(runnerMetadata) : '';
    const nodeStall = stallView.value?.node === nodeId ? stallView.value : null;
    const radius = kind === 'human' ? geometry.hh : 6;
    const markPosition = markPlacement(kind, label, geometry);
    const points = kind === 'code'
      ? `${geometry.cx},${geometry.cy - geometry.hh} `
        + `${geometry.cx + geometry.hw},${geometry.cy} `
        + `${geometry.cx},${geometry.cy + geometry.hh} `
        + `${geometry.cx - geometry.hw},${geometry.cy}`
      : null;
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
      kind,
      label,
      subtitle,
      cx: geometry.cx,
      cy: geometry.cy,
      halfWidth: geometry.hw,
      halfHeight: geometry.hh,
      radius,
      points,
      status,
      runner,
      runnerModel,
      runnerSwitched: Boolean(runnerMetadata?.switched),
      title: [stallTitle, arbiterTitle, runnerTitle].filter(Boolean).join('\n'),
      mark: statusMarks[status] ?? '',
      markX: markPosition.x,
      markY: markPosition.y,
      arbiterVerdict,
      // Метка арбитра висит НАД левым верхним углом, а не внутри узла: правый край занят
      // статусом, а внутри она наезжала на подпись — ширина узла считается по длине
      // текста и места под вторую пилюлю в ней нет (замер: «🔧 Исправление» — наезд).
      // Сверху у холста 36 px запаса (`computeViewBox`), метке хватает её 14.
      arbiterX: geometry.cx - geometry.hw + 12,
      arbiterY: geometry.cy - geometry.hh - 7,
      subtitleY: kind === 'code'
        ? geometry.cy + geometry.hh + 12
        : geometry.cy + geometry.hh + 13,
      runnerY: geometry.cy + geometry.hh + (subtitle ? 24 : 13),
    };
  });
});

function onNodeActivate(
  node: GraphNodeElement,
  event: MouseEvent | KeyboardEvent,
): void {
  if (!nodeInteractive.value) {
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
/* Разбор идёт — это не тревога. Пульс здесь несёт смысл: он единственный отличает
   идущую работу от статичного зелёного «пройдено». */
.graph-stop.arb { color: var(--good);
  background: color-mix(in srgb, var(--good) 12%, transparent);
  border-color: color-mix(in srgb, var(--good) 38%, transparent);
  animation: nodepulse 1.8s ease-in-out infinite; }
.graph { width: 100%; height: auto; display: block; }
/* Наконечник наследует цвет своей линии (context-stroke), а не всегда серый */
#arr path { fill: context-stroke; }
.edges path { marker-end: url(#arr); }
.startdot { fill: var(--good); filter: drop-shadow(0 0 4px var(--good)); }

/* базовый узел */
.ng > rect, .ng > polygon { fill: #0e1611; stroke-width: 1.4; }
.clickable { cursor: pointer; }
.clickable:hover > rect, .clickable:hover > polygon { stroke-width: 3; }
.nt-agent > rect, .nt-agent > polygon { stroke: var(--node-agent); }
.nt-human > rect, .nt-human > polygon { stroke: var(--node-human); }
.nt-code > rect, .nt-code > polygon { stroke: var(--node-code); }
.nlbl { fill: var(--ink); font-size: 11px; font-family: var(--sans); }
.sub { fill: var(--ink-mid); font-size: 9.5px; font-family: var(--mono); }
.runner { fill: var(--accent); font-size: 8.5px; font-family: var(--mono); }
.runner.switched { fill: var(--warn); font-weight: 650; }
/* След арбитра. Жёлтый — решение отдано человеку и всё ещё ждёт его; приглушённый —
   арбитр проехал сам, и действия от человека это не требует. */
.node-arb-bg { fill: color-mix(in srgb, currentColor 18%, var(--surface)); }
.node-arb-human { color: var(--warn); }
.node-arb-resolve, .node-arb-deferred { color: var(--ink-mid); }
/* Знак статуса — часть узла, а не наклейка поверх него: своей подложки у него нет и
   гаснет он вместе с остальным узлом. */
.mk { fill: var(--ink-mid); font-size: 10px; font-family: var(--sans); font-weight: 750;
  pointer-events: none; }
.mk-done, .mk-arb { fill: var(--good); }
.mk-run { fill: var(--accent); }
.mk-wait { fill: var(--warn); }
.mk-stall, .mk-skipbad, .mk-premature, .mk-fail { fill: var(--bad); }
.mk-arbiter { fill: currentColor; }

/* статусы */
.ns-ref { opacity: 1; }
.ns-done > :not(.node-arb) { opacity: .55; }
.ns-pending > :not(.node-arb) { opacity: .30; }
.ns-idle > rect, .ns-idle > polygon { stroke: var(--accent); stroke-dasharray: 6 4; }
.ns-idle > :not(.node-arb) { opacity: .7; }
.ns-skip > rect, .ns-skip > polygon { stroke-dasharray: 4 4; }
.ns-skip > :not(.node-arb) { opacity: .45; }
.ns-run > rect, .ns-run > polygon { stroke: var(--accent); stroke-width: 2.2; fill: #0e1a2b;
  filter: drop-shadow(0 0 9px var(--accent)); animation: nodepulse 1.6s ease-in-out infinite; }
.ns-wait > rect, .ns-wait > polygon { stroke: var(--warn); stroke-width: 2.2; fill: #20160a;
  filter: drop-shadow(0 0 9px var(--warn)); animation: nodepulse 2.2s ease-in-out infinite; }
.ns-stall > rect, .ns-stall > polygon, .ns-premature > rect, .ns-premature > polygon {
  stroke: var(--bad); stroke-width: 2.2; filter: drop-shadow(0 0 8px var(--bad)); }
/* Провал узла: сплошной красный, без прозрачности — упавший стенд должен бросаться
   в глаза, а не теряться среди непройденных этапов. */
.ns-fail > rect, .ns-fail > polygon { stroke: var(--bad); stroke-width: 2.2; fill: #2a1113; }
.ns-fail { opacity: 1; }
.ns-skipbad > rect, .ns-skipbad > polygon { stroke: var(--bad); stroke-dasharray: 5 4;
  filter: drop-shadow(0 0 6px var(--bad)); }
/* Остановку разбирает арбитр. Зелёный — «не тревога, руками не трогай»; но статичный
   зелёный на этой схеме уже занят пройденными узлами (`ns-done`, приглушённые), и
   разбираемый узел слился бы с ними — то есть стал бы невидимым ровно там, где его и
   ищут. Поэтому полная непрозрачность, заливка, свечение и пульс: цвет снимает тревогу,
   движение говорит, что работа идёт. */
.ns-arb > rect, .ns-arb > polygon { stroke: var(--good); stroke-width: 2.2; fill: #0d2015;
  filter: drop-shadow(0 0 9px var(--good)); animation: nodepulse 1.6s ease-in-out infinite; }
.ns-arb { opacity: 1; }

/* рёбра */
.edges path { fill: none; }
.e-off { stroke: var(--idle); opacity: .30; stroke-width: 1.4; }
.e-on { stroke: var(--edge-on); opacity: .7; stroke-width: 1.6; }
.e-flow { stroke: var(--edge-on); opacity: .9; stroke-width: 1.8; stroke-dasharray: 7 6;
  animation: flow 1s linear infinite; filter: drop-shadow(0 0 4px #39d35388); }
.e-fail { stroke: var(--edge-fail); opacity: .5; stroke-width: 1.4; }
.e-loop { stroke: var(--edge-fail); opacity: 1; stroke-width: 2.2; }
.e-loop.e-flow { stroke-dasharray: 7 5; animation: flow 1.1s linear infinite; }
.elbl { fill: var(--ink-mid); font-size: 9px; font-family: var(--mono); }
.elbl-pass { fill: var(--good); font-size: 9px; font-family: var(--mono); }
.elbl-fail { fill: var(--bad); font-size: 9px; font-family: var(--mono); }

@keyframes nodepulse { 50% { opacity: .55; } }
@keyframes flow { to { stroke-dashoffset: -13; } }
@media (prefers-reduced-motion: reduce) {
  .e-flow, .ns-run > rect, .ns-wait > rect, .ns-arb > rect, .ns-arb > polygon,
  .graph-stop.arb {
    animation: none;
  }
}
@media (max-width: 720px) {
  .graph-stop { grid-template-columns: 1fr auto; }
  .graph-stop strong, .graph-stop-hint { grid-column: 1 / -1; }
}
</style>
