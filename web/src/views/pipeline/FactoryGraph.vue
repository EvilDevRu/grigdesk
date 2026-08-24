<template>
  <div class="graph-shell">
    <div v-if="stallView" class="graph-stop" role="alert">
      <span class="graph-stop-stage">🛑 {{ stallView.nodeLabel }}</span>
      <strong>{{ stallView.title }}</strong>
      <span v-if="stallView.fails != null" class="graph-stop-fails">{{ stallView.fails }} сбоев</span>
      <span v-if="stallView.hint" class="graph-stop-hint">{{ stallView.hint }}</span>
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
          {{ node.label }}<tspan
            class="mk"
            :class="`mk-${node.status}`"
          > {{ node.mark }}</tspan>
        </text>
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
import { graphStallView } from '../../shared/graph-stall.js';
import {
  runnerChainLabel,
  runnerModelLabel,
  runnerNodeLabel,
} from '../../shared/runner-display.js';

type GraphPosition = [number, number];
type GraphNodeDefinition = [string, string?, string?];
type GraphEdge = [string, string, string, string, string?];
type LabelPosition = [number, number] | null;

interface RunnerMetadata extends Record<string, unknown> {
  switched?: boolean;
}

interface GraphNodeMetadata {
  runner?: RunnerMetadata;
}

interface FactoryGraphData {
  pos: Record<string, GraphPosition>;
  nodes: Record<string, GraphNodeDefinition>;
  edges: GraphEdge[];
  statuses?: Record<string, string>;
  loops?: Record<string, number>;
  nodeMeta?: Record<string, GraphNodeMetadata>;
  stall?: unknown;
}

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
  subtitleY: number;
  runnerY: number;
}

const props = withDefaults(
  defineProps<{
    graph: FactoryGraphData;
    loopsOn?: boolean;
    reference?: boolean;
    interactive?: boolean;
  }>(),
  {
    loopsOn: false,
    reference: false,
    interactive: false,
  },
);

const emit = defineEmits<{
  node: [node: GraphNodeElement, event: MouseEvent | KeyboardEvent];
}>();

const doneLike = new Set(['done', 'skip']);
const statusMarks = MARKS as Record<string, string>;
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
    const status = props.reference
      ? 'ref'
      : (graph.statuses?.[nodeId] ?? 'pending');
    const runnerMetadata = graph.nodeMeta?.[nodeId]?.runner ?? null;
    const runner = runnerMetadata ? runnerNodeLabel(runnerMetadata) : '';
    const runnerModel = runnerMetadata ? runnerModelLabel(runnerMetadata) : '';
    const nodeStall = stallView.value?.node === nodeId ? stallView.value : null;
    const radius = kind === 'human' ? geometry.hh : 6;
    const points = kind === 'code'
      ? `${geometry.cx},${geometry.cy - geometry.hh} `
        + `${geometry.cx + geometry.hw},${geometry.cy} `
        + `${geometry.cx},${geometry.cy + geometry.hh} `
        + `${geometry.cx - geometry.hw},${geometry.cy}`
      : null;
    const stallTitle = nodeStall
      ? `${nodeStall.title}${nodeStall.hint ? ` — ${nodeStall.hint}` : ''}`
      : '';
    const runnerTitle = runnerMetadata
      ? `${runnerChainLabel(runnerMetadata)}${runnerModel ? ` · модель ${runnerModel}` : ''}`
      : '';

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
      title: [stallTitle, runnerTitle].filter(Boolean).join('\n'),
      mark: statusMarks[status] ?? '',
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
.graph { width: 100%; height: auto; display: block; }
/* Наконечник наследует цвет своей линии (context-stroke), а не всегда серый */
#arr path { fill: context-stroke; }
.edges path { marker-end: url(#arr); }
.startdot { fill: var(--good); filter: drop-shadow(0 0 4px var(--good)); }

/* базовый узел */
.ng rect, .ng polygon { fill: #0e1611; stroke-width: 1.4; }
.clickable { cursor: pointer; }
.clickable:hover rect, .clickable:hover polygon { stroke-width: 3; }
.nt-agent rect, .nt-agent polygon { stroke: var(--node-agent); }
.nt-human rect, .nt-human polygon { stroke: var(--node-human); }
.nt-code rect, .nt-code polygon { stroke: var(--node-code); }
.nlbl { fill: var(--ink); font-size: 11px; font-family: var(--sans); }
.sub { fill: var(--ink-mid); font-size: 9.5px; font-family: var(--mono); }
.runner { fill: var(--accent); font-size: 8.5px; font-family: var(--mono); }
.runner.switched { fill: var(--warn); font-weight: 650; }
.mk { font-size: 11px; }
.mk-done { fill: var(--good); }
.mk-run { fill: var(--accent); }
.mk-wait { fill: var(--warn); }
.mk-stall, .mk-skipbad, .mk-premature { fill: var(--bad); }
.mk-idle { fill: var(--ink-mid); }

/* статусы */
.ns-ref { opacity: 1; }
.ns-done { opacity: .55; }
.ns-pending { opacity: .30; }
.ns-idle rect, .ns-idle polygon { stroke: var(--accent); stroke-dasharray: 6 4; }
.ns-idle { opacity: .7; }
.ns-skip rect, .ns-skip polygon { stroke-dasharray: 4 4; }
.ns-skip { opacity: .45; }
.ns-run rect, .ns-run polygon { stroke: var(--accent); stroke-width: 2.2; fill: #0e1a2b;
  filter: drop-shadow(0 0 9px var(--accent)); animation: nodepulse 1.6s ease-in-out infinite; }
.ns-wait rect, .ns-wait polygon { stroke: var(--warn); stroke-width: 2.2; fill: #20160a;
  filter: drop-shadow(0 0 9px var(--warn)); animation: nodepulse 2.2s ease-in-out infinite; }
.ns-stall rect, .ns-stall polygon, .ns-premature rect, .ns-premature polygon {
  stroke: var(--bad); stroke-width: 2.2; filter: drop-shadow(0 0 8px var(--bad)); }
/* Провал узла: сплошной красный, без прозрачности — упавший стенд должен бросаться
   в глаза, а не теряться среди непройденных этапов. */
.ns-fail rect, .ns-fail polygon { stroke: var(--bad); stroke-width: 2.2; fill: #2a1113; }
.ns-fail { opacity: 1; }
.mk-fail { fill: var(--bad); }
.ns-skipbad rect, .ns-skipbad polygon { stroke: var(--bad); stroke-dasharray: 5 4;
  filter: drop-shadow(0 0 6px var(--bad)); }

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
@media (prefers-reduced-motion: reduce) { .e-flow, .ns-run rect, .ns-wait rect { animation: none; } }
@media (max-width: 720px) {
  .graph-stop { grid-template-columns: 1fr auto; }
  .graph-stop strong, .graph-stop-hint { grid-column: 1 / -1; }
}
</style>
