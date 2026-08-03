<script setup>
import { computed } from 'vue';
import { nodeGeom, edgePath, computeViewBox, MARKS, START_DOT } from '../../shared/graph-geom.js';
import { graphStallView } from '../../shared/graph-stall.js';
import { runnerChainLabel, runnerModelLabel, runnerNodeLabel } from '../../shared/runner-display.js';

// graph — ответ /api/tasks/:id/graph; loopsOn — показывать потенциальные fail-рёбра.
const props = defineProps({
  graph: { type: Object, required: true },
  loopsOn: { type: Boolean, default: false },
  reference: { type: Boolean, default: false }, // эталонная схема маршрута (без статусов задачи)
  interactive: { type: Boolean, default: false }, // клики по узлам даже в reference (редактор маршрутов)
});
const emit = defineEmits(['node']);

const doneLike = new Set(['done', 'skip']);
const stallView = computed(() => (props.reference ? null : graphStallView(props.graph)));

// Тесный viewBox по узлам (убирает пустоту зашитого vb).
const vb = computed(() => computeViewBox(props.graph.pos, props.graph.nodes));

// Рёбра с вычисленным визуальным классом и подписью.
const edgeEls = computed(() => {
  const g = props.graph;
  const statuses = g.statuses || {};
  const out = [];
  for (const [src, dst, label, cls, routing] of g.edges) {
    const { d, label: lp } = edgePath(src, dst, routing, g.pos, g.nodes);
    let klass; let lbl = label; let visible = true; let lblClass = 'elbl';
    if (cls === 'fail') {
      if (props.reference) { klass = 'e-fail'; lblClass = 'elbl-fail'; }
      else {
        const n = g.loops?.[src] || 0;
        klass = n > 0 ? 'e-loop' : 'e-fail';
        if (n > 0 && statuses[dst] === 'run') klass += ' e-flow';
        lbl = n > 0 ? `${label} ×${n}` : label;
        visible = props.loopsOn || n > 0; // потенциальные петли — только по тумблеру
        lblClass = 'elbl-fail';
      }
    } else if (props.reference) {
      klass = 'e-on';
      lblClass = cls === 'pass' ? 'elbl-pass' : 'elbl';
    } else {
      const s = src === '_start' ? 'done' : statuses[src];
      klass = doneLike.has(s) ? 'e-on' : s === 'run' ? 'e-flow' : 'e-off';
      lblClass = cls === 'pass' ? 'elbl-pass' : 'elbl';
    }
    out.push({ key: `${src}-${dst}`, d, klass, lbl, lp, lblClass, visible });
  }
  return out;
});

// Узлы с геометрией, статусом, типом.
const nodeEls = computed(() => {
  const g = props.graph;
  return Object.keys(g.pos).map((nid) => {
    const def = g.nodes[nid] || ['agent', nid, ''];
    const kind = def[0];
    const label = def[1] || nid;
    const sub = def[2] || '';
    const { cx, cy, hw, hh } = nodeGeom(nid, g.pos, g.nodes);
    const status = props.reference ? 'ref' : ((g.statuses || {})[nid] || 'pending');
    const runnerMeta = g.nodeMeta?.[nid]?.runner || null;
    const runner = runnerMeta ? runnerNodeLabel(runnerMeta) : '';
    const runnerModel = runnerMeta ? runnerModelLabel(runnerMeta) : '';
    const nodeStall = stallView.value?.node === nid ? stallView.value : null;
    const rx = kind === 'human' ? hh : 6;
    const points = kind === 'code'
      ? `${cx},${cy - hh} ${cx + hw},${cy} ${cx},${cy + hh} ${cx - hw},${cy}`
      : null;
    return {
      nid, kind, label, sub, cx, cy, hw, hh, rx, points, status,
      runner, runnerModel, runnerSwitched: !!runnerMeta?.switched,
      nodeTitle: [
        nodeStall ? `${nodeStall.title}${nodeStall.hint ? ` — ${nodeStall.hint}` : ''}` : '',
        runnerMeta ? `${runnerChainLabel(runnerMeta)}${runnerModel ? ` · модель ${runnerModel}` : ''}` : '',
      ].filter(Boolean).join('\n'),
      mark: MARKS[status] || '',
      subY: kind === 'code' ? cy + hh + 12 : cy + hh + 13,
      runnerY: cy + hh + (sub ? 24 : 13),
    };
  });
});
</script>

<template>
  <div class="graph-shell">
    <div v-if="stallView" class="graph-stop" role="alert">
      <span class="graph-stop-stage">🛑 {{ stallView.nodeLabel }}</span>
      <strong>{{ stallView.title }}</strong>
      <span v-if="stallView.fails != null" class="graph-stop-fails">{{ stallView.fails }} сбоев</span>
      <span v-if="stallView.hint" class="graph-stop-hint">{{ stallView.hint }}</span>
    </div>

    <svg class="graph" :viewBox="vb" preserveAspectRatio="xMidYMid meet">
    <defs>
      <marker id="arr" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path d="M0,0 L8,4 L0,8 z" />
      </marker>
    </defs>

    <!-- старт -->
    <circle class="startdot" :cx="START_DOT[0]" :cy="START_DOT[1]" r="4" />

    <!-- рёбра -->
    <g class="edges">
      <template v-for="e in edgeEls" :key="e.key">
        <path v-if="e.visible" :d="e.d" :class="e.klass" marker-end="url(#arr)" />
        <text v-if="e.visible && e.lbl && e.lp" :x="e.lp[0]" :y="e.lp[1]" :class="e.lblClass" text-anchor="middle">{{ e.lbl }}</text>
      </template>
    </g>

    <!-- узлы -->
    <g v-for="n in nodeEls" :key="n.nid" class="ng" :class="[`ns-${n.status}`, `nt-${n.kind}`, { clickable: interactive || !reference }]"
       @click="(interactive || !reference) && emit('node', n, $event)">
      <title v-if="n.nodeTitle">{{ n.nodeTitle }}</title>
      <polygon v-if="n.points" :points="n.points" />
      <rect v-else :x="n.cx - n.hw" :y="n.cy - n.hh" :width="n.hw * 2" :height="n.hh * 2" :rx="n.rx" />
      <text :x="n.cx" :y="n.cy + 4" text-anchor="middle" class="nlbl">{{ n.label }}<tspan class="mk" :class="`mk-${n.status}`"> {{ n.mark }}</tspan></text>
      <text v-if="n.sub" :x="n.cx" :y="n.subY" text-anchor="middle" class="sub">{{ n.sub }}</text>
      <text v-if="n.runner" :x="n.cx" :y="n.runnerY" text-anchor="middle"
            class="runner" :class="{ switched: n.runnerSwitched }">
        {{ n.runner }}<tspan v-if="n.runnerModel"> · {{ n.runnerModel }}</tspan>
      </text>
    </g>
    </svg>
  </div>
</template>

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
