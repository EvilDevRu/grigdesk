<template>
  <section class="route-canvas">
    <div class="route-canvas__toolbar">
      <div class="route-canvas__zoom" role="group" aria-label="Масштаб схемы">
        <UiButton aria-label="Уменьшить масштаб" data-test="zoom-out" :disabled="scale <= MIN_SCALE" @click="zoomBy(1 / ZOOM_STEP)">
          −
        </UiButton>
        <UiButton data-test="zoom-reset" :disabled="scale === 1" @click="scale = 1">100%</UiButton>
        <UiButton aria-label="Увеличить масштаб" data-test="zoom-in" :disabled="scale >= MAX_SCALE" @click="zoomBy(ZOOM_STEP)">
          +
        </UiButton>
        <UiButton data-test="fit-all" @click="fitAll">Показать всё</UiButton>
      </div>
      <label class="route-canvas__search">Найти этап
        <UiInput data-test="search-nodes" :model-value="searchTerm" placeholder="Подпись или ID"
                 @update:model-value="searchTerm = String($event ?? '')"
                 @keydown.enter="searchNode" />
      </label>
      <details class="route-canvas__connections">
        <summary>Соединения</summary>
        <div class="route-canvas__connection-fields">
      <label>Источник
        <UiSelect data-test="connect-source" :model-value="connectSourceId"
                  @update:model-value="changeConnectSource(String($event ?? ''))">
          <option v-for="source in executableNodes" :key="source.id" :value="source.id">
            {{ source.label || source.id }}
          </option>
        </UiSelect>
      </label>
      <label>Исход
        <UiSelect data-test="connect-outcome" :model-value="connectOutcome"
                  @update:model-value="connectOutcome = String($event ?? '')">
          <option v-for="outcome in connectOutcomes" :key="outcome" :value="outcome">
            {{ outcome }}
          </option>
        </UiSelect>
      </label>
      <UiButton data-test="connect-start" :disabled="!connectSourceId || !connectOutcome"
                @click="connecting = true">Соединить с узлом</UiButton>        </div>
      </details>
      <span v-if="connecting" class="muted">Выберите цель на схеме</span>
      <span v-if="connectError" class="bad">{{ connectError }}</span>
    </div>
    <div ref="viewport" class="route-canvas__graph">
      <FactoryGraph v-if="graph" :graph="graph" reference interactive
                    :selected-node="selectedNodeId || null" :scale="scale" @node="activateNode" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import { buildRouteGraph } from '../../../../shared/pipeline/routeGraphView.ts';
import type { RouteGraphDef, RouteMachine } from '../../../../shared/pipeline/routeGraphView.ts';
import type { DraftMachine } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteDraft, RouteEditorIssue } from '../../../../shared/pipeline/routesEditorContracts.ts';
import FactoryGraph from '../pipeline/FactoryGraph.vue';
import type { RouteCommandScope } from './routeCommands.ts';
import { setTransition } from './routeCommands.ts';
import { UiButton, UiInput, UiSelect } from '../../ui';

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
}>();
const emit = defineEmits<{
  'select-node': [value: { scope: RouteCommandScope; nodeId: string }];
  'focus-field': [value: {
    scope: RouteCommandScope;
    nodeId: string;
    path: string;
  }];
  change: [document: RouteDraft];
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
const graph = computed<RouteGraphDef | null>(() => {
  const current = machine.value;

  if (!current) {
    return null;
  }

  const bootstrap = props.scope.kind === 'bootstrap';
  const routeId = props.scope.kind === 'route' ? props.scope.routeId : 'bootstrap';

  // У маршрута линия перечисляет все свои исходы; у выбора маршрута исход всегда `done`,
  // и одинаковая подпись на каждой линии разведки только шумела бы.
  return buildRouteGraph(graphMachine(current, bootstrap), routeId, {
    workspaceMode: 'shared',
    outcomeLabels: bootstrap ? 'minimal' : 'all',
    routeChoices: bootstrap,
    nodeIds: true,
  });
});
const executableNodes = computed(() => machine.value?.nodes.filter((node) =>
  node.executor !== 'status') ?? []);
const connectSource = computed(() => executableNodes.value.find((node) =>
  node.id === connectSourceId.value) ?? null);
const connectOutcomes = computed(() => Object.keys(connectSource.value?.on ?? {}));

/**
 * Машина черновика в форме построителя схемы: пустой entry и неполный sequence допустимы,
 * черновик бывает незаконченным. Разведка рисуется по собственному sequence.
 */
function graphMachine(source: DraftMachine, bootstrap: boolean): RouteMachine {
  return {
    entry: source.entry ?? undefined,
    loop: bootstrap ? undefined : source.loop,
    sequence: {
      main: (bootstrap ? source.sequence.bootstrap : source.sequence.main) ?? [],
      tail: bootstrap ? [] : source.sequence.tail ?? [],
    },
    nodes: source.nodes,
  };
}

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
    connectError.value = result.issues[0]?.message ?? 'Переход не изменён.';

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
</script>

<style scoped>
.route-canvas {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-2);
}
.route-canvas__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--line);
}
.route-canvas__toolbar label { display: grid; gap: 3px; }
.route-canvas__search { width: min(100%, 240px); }
.route-canvas__zoom { display: flex; flex-wrap: wrap; gap: 6px; }
.route-canvas__connections { flex: 1 0 100%; }
.route-canvas__connections summary { cursor: pointer; color: var(--ink-mid); }
.route-canvas__connection-fields { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.route-canvas__graph { min-width: 0; padding: 8px 10px; }
</style>
