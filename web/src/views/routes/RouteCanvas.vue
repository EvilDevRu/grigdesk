<template>
  <section class="route-canvas">
    <div class="route-canvas__toolbar">
      <strong>{{ t('core.routeShema2') }}</strong>
      <UiButton data-context="workspace-form" variant="ghost" data-test="auto-layout"
          v-tooltip="t('core.routeVernutAvtoraskladkuPodskazka')"
          @click="autoLayout">{{ t('core.routeUporyadochitAvtomaticheski') }}</UiButton>

      <div class="route-canvas__zoom" role="group" :aria-label="t('core.routeMasshtabShemy')">
        <UiIconButton data-context="workspace-form" :label="t('core.routeUmenshitMasshtab')"
                      v-tooltip="t('core.routeUmenshitMasshtab')" data-test="zoom-out"
                      :disabled="scale <= MIN_SCALE" @click="zoomBy(1 / ZOOM_STEP)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
               stroke-linecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
        </UiIconButton>
        <UiButton data-context="workspace-form" variant="ghost" data-test="zoom-reset"
                  v-tooltip="t('core.routeMasshtab100')" :disabled="scale === 1" @click="scale = 1">100%</UiButton>
        <UiIconButton data-context="workspace-form" :label="t('core.routeUvelichitMasshtab')"
                      v-tooltip="t('core.routeUvelichitMasshtab')" data-test="zoom-in"
                      :disabled="scale >= MAX_SCALE" @click="zoomBy(ZOOM_STEP)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
               stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M12 5v14" /></svg>
        </UiIconButton>
        <UiIconButton data-context="workspace-form" :label="t('core.routePokazatVse')"
                      v-tooltip="t('core.routePokazatVsyuShemu')" data-test="fit-all" @click="fitAll">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
          </svg>
        </UiIconButton>
      </div>
      <label class="route-canvas__search"><span class="ui-visually-hidden">{{ t('core.routeNaytiEtap') }}</span>
        <UiInput data-test="search-nodes" :model-value="searchTerm" :placeholder="t('core.routeNazvanieEtapaIliId')"
                 @update:model-value="searchTerm = String($event ?? '')"
                 @keydown.enter="searchNode" />
      </label>
    <UiButton data-context="workspace-form" data-test="canvas-add-stage"
              :disabled="scope.kind !== 'route'" @click="emit('add-at', defaultAddPoint())">
      {{ t('core.routeDobavitEtap') }}
    </UiButton>
      <details v-if="!chooseMode" class="route-canvas__connections">
        <summary>{{ t('core.routeSoedineniya') }}</summary>
        <div class="route-canvas__connection-fields">
      <label>{{ t('core.trackerSource') }} <UiSelect data-test="connect-source" :model-value="connectSourceId"
                  @update:model-value="changeConnectSource(String($event ?? ''))">
          <option v-for="source in executableNodes" :key="source.id" :value="source.id">
            {{ source.label || source.id }}
          </option>
        </UiSelect>
      </label>
      <label>{{ t('core.routeIshod') }} <UiSelect data-test="connect-outcome" :model-value="connectOutcome"
                  @update:model-value="connectOutcome = String($event ?? '')">
          <option v-for="outcome in connectOutcomes" :key="outcome" :value="outcome">
            {{ outcome }}
          </option>
        </UiSelect>
      </label>
      <UiButton data-context="workspace-form" variant="ghost" data-test="connect-start" :disabled="!connectSourceId || !connectOutcome"
                @click="connecting = true">{{ t('core.routeSoedinitSUzlom') }}</UiButton>        </div>
      </details>
      <span v-if="connecting" class="muted">{{ t('core.routeVyberiteTselNaSheme') }}</span>
      <span v-if="connectError" class="bad">{{ connectError }}</span>
    </div>


    <div v-if="selectedOutcomes.length" class="route-canvas__outcomes" data-test="outcome-chips">
      <span>{{ t('core.routeIshodyVybrannogoEtapa') }}</span>
      <UiButton v-for="outcome in selectedOutcomes" :key="outcome"
                data-context="workspace-form" :data-test="`outcome-chip-${outcome}`"
                v-tooltip="t('core.routePeretashiteEtapDlyaPerehoda')"
                @pointerdown="beginOutcomeDrag($event, outcome)">
        {{ outcome }}
      </UiButton>
    </div>
    <Teleport to="body">
      <span v-if="gesture?.kind === 'outcome' && gesture.moved" :style="outcomeGhostStyle"
            aria-hidden="true" data-test="outcome-ghost">{{ gesture.outcome }}</span>
    </Teleport>

    <div ref="viewport" class="route-canvas__graph"
         @pointerdown="beginNodeDrag" @click.capture="guardCanvasClick"
         @lostpointercapture="cancelGesture" @click="addAtEmpty">
      <FactoryGraph v-if="graph" :graph="graph" reference interactive keep-positions
                    :fixed-view-box="gesture?.viewBox ?? null"
                    :selected-node="selectedNodeId || null" :scale="scale"
                    :highlight-selected-edges="highlightSelectedEdges" @node="activateNode" />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { CSSProperties } from 'vue';
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';

import type { RouteDraft, RouteEditorIssue } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteGraphDef } from '../../../../shared/pipeline/routeGraphView.ts';
import { canvasNodeAt, captureCanvasTransform, canvasPoint, plainRouteValue } from './routeCanvasGeometry.ts';
import type { CanvasTransform } from './routeCanvasGeometry.ts';
import FactoryGraph from '../pipeline/FactoryGraph.vue';
import type { NodeCanvasPoint, RouteCommandScope } from './routeCommands.ts';
import { canvasGraph, moveNodePosition, resetScopeLayout, setTransition } from './routeCommands.ts';
import { UiButton, UiIconButton, UiInput, UiSelect, vTooltip, t } from '../../ui';

// Узел, который схема отдаёт по активации: ID на схеме и ID в машине.
interface ActivatedNode {
  id: string;
  originId: string | null;
}

const props = defineProps<{
  document: RouteDraft;
  scope: RouteCommandScope;
  selectedNodeId?: string;
  focusedIssue?: RouteEditorIssue | null;
  chooseMode?: boolean;
  highlightSelectedEdges?: boolean;
}>();
const emit = defineEmits<{
  'select-node': [value: { scope: RouteCommandScope; nodeId: string }];
  'focus-field': [value: {
    scope: RouteCommandScope;
    nodeId: string;
    path: string;
  }];
  change: [document: RouteDraft];
  'choose-place': [nodeId: string];
  'add-at': [point: NodeCanvasPoint];
}>();

// Шаг и пределы масштаба: ниже половины натурального размера текст узлов не читается.
const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;

const viewport = ref<HTMLElement | null>(null);
const connectSourceId = ref(props.selectedNodeId ?? '');
const connectOutcome = ref('done');
const connecting = ref(false);
const connectError = ref('');
const scale = ref(1);
const searchTerm = ref('');
const machine = computed(() => props.scope.kind === 'bootstrap'
  ? props.document.bootstrap : props.document.routes[props.scope.routeId]?.route);
// Та же схема, что у конвейера и опубликованного маршрута. Стенд зависит от профиля,
// а не от машины, поэтому холст его не рисует; разведка показывает, из чего выбирает.
interface CanvasGesture {
  kind: 'node' | 'outcome';
  pointerId: number;
  nodeId: string;
  outcome?: string;
  startX: number;
  startY: number;
  base: [number, number];
  startGraph: NodeCanvasPoint;
  transform: CanvasTransform;
  viewBox: string | null;
  graph: RouteGraphDef;
  document: RouteDraft;
  moved: boolean;
  ghost: [number, number] | null;
  client: NodeCanvasPoint;
}

const gesture = ref<CanvasGesture | null>(null);
const suppressClick = ref(false);
let captureElement: Element | null = null;

const graph = computed(() => {
  const state = gesture.value;
  const preview: Record<string, [number, number]> = {};

  if (state?.kind === 'node' && state.ghost) {
    preview[state.nodeId] = state.ghost;
  }

  return canvasGraph(props.document, props.scope, preview);
});

function svgElement(): SVGSVGElement | null {
  return viewport.value?.querySelector<SVGSVGElement>('svg.graph') ?? null;
}

/**
 * Создаёт снимок систем координат и документа до изменения ghost.
 * Перестройка viewBox во время жеста не влияет на последующие pointermove.
 */
function startGesture(
  event: PointerEvent,
  kind: CanvasGesture['kind'],
  nodeId: string,
  base: [number, number],
  outcome?: string,
): void {
  if (!graph.value || gesture.value) {
    return;
  }

  const svg = svgElement();
  const transform = captureCanvasTransform(svg);

  suppressClick.value = false;
  gesture.value = {
    kind,
    pointerId: event.pointerId,
    nodeId,
    outcome,
    startX: event.clientX,
    startY: event.clientY,
    base: [...base],
    startGraph: canvasPoint(event, transform),
    transform,
    viewBox: svg?.getAttribute('viewBox') ?? null,
    graph: plainRouteValue(graph.value),
    document: props.document,
    moved: false,
    ghost: null,
    client: { x: event.clientX, y: event.clientY },
  };
}

/**
 * Нажатие на этапе лишь вооружает drag; capture включится после порога 4 px.
 * Поэтому обычный браузерный click остаётся на прежнем UiSvgPressable.
 */
function beginNodeDrag(event: PointerEvent): void {
  if (event.button !== 0 || gesture.value) {
    return;
  }

  suppressClick.value = false;

  if (props.chooseMode || connecting.value || !graph.value) {
    return;
  }

  const target = (event.target as Element | null)?.closest('[data-node]');
  const displayId = target?.getAttribute('data-node');
  const origin = displayId ? graph.value.nodeOrigins[displayId] : null;
  const base = displayId ? graph.value.pos[displayId] : null;

  if (origin?.executable && origin.originId && base) {
    startGesture(event, 'node', origin.originId, [base[0], base[1]]);
  }
}

/**
 * Сопровождает только свой pointerId. После порога захватывает указатель на viewport,
 * а не на вложенном узле; финальный синтетический click отдельно подавляется.
 */
function movePointer(event: PointerEvent): void {
  const state = gesture.value;

  if (!state || event.pointerId !== state.pointerId) {
    return;
  }
  if (state.document !== props.document) {
    cancelGesture();

    return;
  }
  if (!state.moved && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 4) {
    return;
  }

  if (!state.moved) {
    state.moved = true;
    captureElement = viewport.value;

    try {
      captureElement?.setPointerCapture?.(state.pointerId);
    } catch {
      // Window listeners сохраняют жест, если браузер уже отменил захват указателя.
    }
  }

  event.preventDefault();
  state.client = { x: event.clientX, y: event.clientY };

  if (state.kind === 'node') {
    const point = canvasPoint(event, state.transform);

    state.ghost = [
      Math.min(100000, Math.max(0, state.base[0] + point.x - state.startGraph.x)),
      Math.min(100000, Math.max(0, state.base[1] + point.y - state.startGraph.y)),
    ];
  }
}

/**
 * Снимает capture после удаления состояния: lostpointercapture уже не отменяет новый жест.
 * Ошибки освобождения не мешают очистке после pointercancel или размонтирования.
 */
function releaseGesture(state: CanvasGesture): void {
  gesture.value = null;

  try {
    captureElement?.releasePointerCapture?.(state.pointerId);
  } catch {
    // Захват мог быть снят браузером автоматически.
  }

  captureElement = null;
}

/**
 * Отпускание своего указателя фиксирует последнюю точку ровно одной командой.
 * Сравнивается plain snapshot; Vue proxy никогда не передаётся structuredClone.
 */
function endPointer(event: PointerEvent): void {
  const state = gesture.value;

  if (!state || event.pointerId !== state.pointerId) {
    return;
  }

  movePointer(event);

  if (gesture.value !== state) {
    return;
  }

  suppressClick.value = state.moved;

  if (state.document !== props.document || !state.moved) {
    releaseGesture(state);

    return;
  }

  if (state.kind === 'outcome') {
    finishOutcome(state, event);
  } else if (state.ghost) {
    const input = plainRouteValue(props.document);
    const result = moveNodePosition(input, props.scope, state.nodeId,
      { x: state.ghost[0], y: state.ghost[1] });

    if (result.draft !== input) {
      emit('change', result.draft);
    }
  }

  releaseGesture(state);
}

/**
 * Находит попадание по сохранённой показанной схеме, исключая source до очистки state.
 * Команда получает plain snapshot; пустое пространство и отмена не создают запись.
 */
function finishOutcome(state: CanvasGesture, event: PointerEvent): void {
  const target = canvasNodeAt(state.graph, canvasPoint(event, state.transform), state.nodeId);

  if (!target || !state.outcome) {
    return;
  }

  const input = plainRouteValue(props.document);
  const result = setTransition(input, props.scope, state.nodeId, state.outcome, { next: target });

  if (result.draft === input) {
    connectError.value = result.issues[0]?.message ?? t('core.routePerehodNeIzmenen');

    return;
  }

  emit('change', result.draft);
}

/**
 * Отмена не вызывает команды и не меняет историю. Чужой pointercancel игнорируется.
 * Следующий pointerdown снимет подавление возможного click после отменённого drag.
 */
function cancelGesture(event?: Event): void {
  const state = gesture.value;

  if (!state || (event && 'pointerId' in event && event.pointerId !== state.pointerId)) {
    return;
  }

  suppressClick.value = state.moved;
  releaseGesture(state);
}

function cancelOnEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && gesture.value) {
    event.preventDefault();
    cancelGesture();
  }
}

/**
 * Capture-фаза гасит click после переноса до выбора узла и добавления этапа.
 * Нажатие без движения флаг не ставит, поэтому прежняя активация работает.
 */
function guardCanvasClick(event: MouseEvent): void {
  if (suppressClick.value) {
    suppressClick.value = false;
    event.preventDefault();
    event.stopPropagation();
  }
}

onMounted(() => {
  window.addEventListener('pointermove', movePointer, { passive: false });
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', cancelGesture);
  window.addEventListener('blur', cancelGesture);
  window.addEventListener('resize', cancelGesture);
  window.addEventListener('scroll', cancelGesture, true);
  window.addEventListener('keydown', cancelOnEscape);
});

onBeforeUnmount(() => {
  cancelGesture();
  window.removeEventListener('pointermove', movePointer);
  window.removeEventListener('pointerup', endPointer);
  window.removeEventListener('pointercancel', cancelGesture);
  window.removeEventListener('blur', cancelGesture);
  window.removeEventListener('resize', cancelGesture);
  window.removeEventListener('scroll', cancelGesture, true);
  window.removeEventListener('keydown', cancelOnEscape);
});

watch(() => `${props.document.id}|${props.scope.kind}|${
  props.scope.kind === 'route' ? props.scope.routeId : ''
}`, () => cancelGesture());

const executableNodes = computed(() => machine.value?.nodes.filter((node) =>
  node.executor !== 'status') ?? []);
const connectSource = computed(() => executableNodes.value.find((node) =>
  node.id === connectSourceId.value) ?? null);
const connectOutcomes = computed(() => Object.keys(connectSource.value?.on ?? {}));


function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(value * 100) / 100));
}

function zoomBy(factor: number): void {
  scale.value = clampScale(scale.value * factor);
}

/**
 * Подгоняет схему под ширину холста, не увеличивая её и не опускаясь ниже читаемого
 * масштаба. Натуральную ширину сообщает viewBox, который FactoryGraph уже посчитал.
 */
function fitAll(): void {
  const svg = viewport.value?.querySelector('svg.graph');
  const natural = Number(svg?.getAttribute('viewBox')?.split(' ')[2]);
  // Поля холста не входят в ширину схемы, иначе «всё» вылезало бы на полосу прокрутки.
  const available = (viewport.value?.clientWidth ?? 0) - 24;

  if (!natural || available <= 0) {
    return;
  }

  scale.value = clampScale(Math.min(1, available / natural));
}

function scrollToNode(nodeId: string): void {
  viewport.value?.querySelector(`[data-node="${nodeId}"]`)?.scrollIntoView?.({
    block: 'nearest',
    inline: 'center',
  });
}

/**
 * Клик по этапу схемы: в режиме соединения он становится целью перехода, иначе выбирает
 * этап для инспектора. Служебные узлы схема не активирует вовсе.
 */
function activateNode(node: ActivatedNode): void {
  const nodeId = node.originId ?? node.id;

  if (props.chooseMode) {
    emit('choose-place', nodeId);

    return;
  }
  if (connecting.value) {
    connectTo(nodeId);

    return;
  }

  emit('select-node', { scope: props.scope, nodeId });
}

function changeConnectSource(nodeId: string): void {
  connectSourceId.value = nodeId;

  const source = executableNodes.value.find((node) => node.id === nodeId);

  connectOutcome.value = Object.keys(source?.on ?? {})[0] ?? '';
}

/**
 * Находит этап по подписи или ID, выбирает его и прокручивает схему к нему.
 * Служебные узлы в поиск не входят: выбрать их в инспекторе нельзя.
 */
function searchNode(): void {
  const query = searchTerm.value.trim().toLocaleLowerCase('ru-RU');

  if (!query) {
    return;
  }

  const found = executableNodes.value.find((node) => (
    (node.label ?? '').toLocaleLowerCase('ru-RU').includes(query)
      || node.id.toLocaleLowerCase('ru-RU').includes(query)
  ));

  if (found) {
    emit('select-node', { scope: props.scope, nodeId: found.id });
  }
}

/**
 * Создаёт переход от выбранного источника к цели.
 * Отказ команды остаётся на холсте текстом, а черновик не меняется.
 */
function connectTo(targetId: string): void {
  connecting.value = false;
  connectError.value = '';

  if (!connectSourceId.value || !connectOutcome.value) {
    return;
  }

  const plain = JSON.parse(JSON.stringify(props.document)) as RouteDraft;
  const result = setTransition(plain, props.scope, connectSourceId.value,
    connectOutcome.value, { next: targetId });

  if (result.draft === plain) {
    connectError.value = result.issues[0]?.message ?? t('core.routePerehodNeIzmenen');

    return;
  }

  emit('change', result.draft);
}

watch(executableNodes, (nodes) => {
  if (!nodes.some((node) => node.id === connectSourceId.value)) {
    changeConnectSource(nodes[0]?.id ?? '');
  }
}, { immediate: true });

// Выбор из списка этапов или поиска подводит схему к узлу, если он за краем холста.
watch(() => props.selectedNodeId, (nodeId) => {
  if (nodeId) {
    void nextTick(() => scrollToNode(nodeId));
  }
});

watch(() => props.focusedIssue, (issue) => {
  if (!issue?.nodeId || issue.scope !== props.scope.kind
    || (props.scope.kind === 'route' && issue.routeId !== props.scope.routeId)) {
    return;
  }

  emit('select-node', { scope: props.scope, nodeId: issue.nodeId });
  emit('focus-field', {
    scope: props.scope,
    nodeId: issue.nodeId,
    path: issue.path,
  });
}, { immediate: true });
/**
 * Клик по свободному фону открывает роль в точке SVG, включая масштаб и letterboxing.
 * Клик узла и штатные режимы выбора цели не превращаются в добавление.
 */
function addAtEmpty(event: MouseEvent): void {
  if (event.defaultPrevented || props.chooseMode || connecting.value || gesture.value
    || props.scope.kind !== 'route'
    || (event.target as Element | null)?.closest('[data-node]')) {
    return;
  }

  emit('add-at', canvasPoint(event, captureCanvasTransform(svgElement())));
}

/**
 * Клавиатурная кнопка предлагает точку правее самого правого показанного этапа.
 * Берутся эффективные координаты graph.pos, включая автоматические узлы.
 */
function defaultAddPoint(): NodeCanvasPoint {
  let last: [number, number] | null = null;

  for (const [displayId, origin] of Object.entries(graph.value?.nodeOrigins ?? {})) {
    const point = graph.value?.pos[displayId];

    if (origin.executable && point && (!last || point[0] > last[0])) {
      last = [point[0], point[1]];
    }
  }

  return last ? { x: last[0] + 340, y: last[1] } : { x: 140, y: 50 };
}

const selectedOutcomes = computed(() => {
  const selected = machine.value?.nodes.find((node) => node.id === props.selectedNodeId);

  return selected && selected.executor !== 'status' ? Object.keys(selected.on ?? {}) : [];
});
const outcomeGhostStyle = computed<CSSProperties>(() => ({
  position: 'fixed',
  pointerEvents: 'none',
  left: `${(gesture.value?.client.x ?? 0) + 12}px`,
  top: `${(gesture.value?.client.y ?? 0) + 12}px`,
}));

/**
 * Исход использует тот же pointer lifecycle и зафиксированный SVG transform, что узел.
 * Захват не начинается до движения; второй pointer не перезаписывает первый жест.
 */
function beginOutcomeDrag(event: PointerEvent, outcome: string): void {
  if (event.button !== 0 || gesture.value || !props.selectedNodeId || !graph.value
    || !selectedOutcomes.value.includes(outcome) || props.chooseMode || connecting.value) {
    return;
  }

  connectError.value = '';
  startGesture(event, 'outcome', props.selectedNodeId, [0, 0], outcome);
}


/**
 * Возвращает автоматическую змейку: ручные координаты области снимаются одной
 * командой, отменяется штатной историей.
 */
function autoLayout(): void {
  const input = plainRouteValue(props.document);
  const result = resetScopeLayout(input, props.scope);

  if (result.draft !== input) {
    emit('change', result.draft);
  }
}

</script>

<style scoped>
.route-canvas {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.route-canvas__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: var(--sidebar);
  border-bottom: 1px solid var(--line);
}

.route-canvas__toolbar label {
  display: grid;
  gap: 3px;
}

.route-canvas__search {
  width: min(100%, 240px);
}

.route-canvas__zoom {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.route-canvas__connections {
  min-width: 0;
}

.route-canvas__connections summary {
  cursor: pointer;
  color: var(--ink-mid);
  min-height: var(--toolbar-control-h);
  padding-block: 4px;
  font-size: 12px;
}

.route-canvas__connection-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  align-items: end;
}

.route-canvas__graph {
  min-width: 0;
  padding: 12px 8px;
  overflow: auto;
}

.route-canvas__outcomes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px;
}
</style>
