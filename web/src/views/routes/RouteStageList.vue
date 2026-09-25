<template>
  <section class="route-stage-list" tabindex="0" aria-label="Список этапов маршрута"
           @keydown="onKeydown">
    <strong>Этапы</strong>
    <small class="muted">Insert — добавить · Alt+↑/↓ — переместить · Delete — показать удаление</small>
    <div class="route-stage-list__tools">
      <label>Тип нового этапа
        <UiSelect data-test="stage-new-type" :model-value="newType"
                  @update:model-value="newType = String($event) as NewExecutor">
          <option value="agent">Агент</option><option value="command">Команда</option>
          <option value="gate">Решение</option><option value="status">Статус</option>
        </UiSelect>
      </label>
      <label v-if="newType === 'status'">Владелец
        <UiSelect data-test="stage-owner" :model-value="statusOwnerId"
                  @update:model-value="statusOwnerId = String($event)">
          <option value="">Выберите этап</option>
          <option v-for="node in executableNodes" :key="node.id" :value="node.id">
            {{ node.label || node.id }}
          </option>
        </UiSelect>
      </label>
      <UiButton data-test="stage-add" @click="add">Добавить этап</UiButton>
    </div>
    <ol class="route-stage-list__rows">
      <li v-for="node in nodes" :key="node.id">
        <UiButton :data-test="`stage-select-${node.id}`" :pressed="selectedNodeId === node.id"
                  @click="select(node.id)">{{ node.label || node.id }} · {{ node.executor }} · {{ node.phase }}</UiButton>
      </li>
    </ol>
    <div class="route-stage-list__tools">
      <UiButton data-test="stage-up" :disabled="!canMove(-1)" @click="move(-1)">Выше</UiButton>
      <UiButton data-test="stage-down" :disabled="!canMove(1)" @click="move(1)">Ниже</UiButton>
      <label v-if="scope.kind === 'route'">Фаза
        <UiSelect data-test="stage-phase" :model-value="targetPhase"
                  @update:model-value="targetPhase = String($event) as 'main' | 'tail'">
          <option value="main">Основная</option><option value="tail">Завершение</option>
        </UiSelect>
      </label>
      <UiButton v-if="scope.kind === 'route'" data-test="stage-move-phase"
                :disabled="!selectedNode || selectedNode.executor === 'status'"
                @click="moveToPhase">Перенести в фазу</UiButton>
      <UiButton data-test="stage-delete" :disabled="!selectedNodeId" @click="previewDelete">
        Удалить этап
      </UiButton>
    </div>
    <div v-if="selectedNode && selectedNode.executor !== 'status'" class="route-stage-list__tools">
      <label>Исход
        <UiSelect data-test="stage-outcome" :model-value="outcome"
                  @update:model-value="outcome = String($event)">
          <option v-for="key in outcomes" :key="key" :value="key">{{ key }}</option>
        </UiSelect>
      </label>
      <label>Цель
        <UiSelect data-test="stage-target" :model-value="targetId"
                  @update:model-value="targetId = String($event)">
          <option value="">Выберите этап</option>
          <option v-for="node in executableNodes" :key="node.id" :value="node.id">
            {{ node.label || node.id }}
          </option>
        </UiSelect>
      </label>
      <UiButton data-test="stage-connect" :disabled="!outcome || !targetId"
                @click="connect">Соединить</UiButton>
    </div>
    <div v-if="deletePreview" data-test="stage-delete-preview" class="route-stage-list__preview">
      <strong>Удаление «{{ deletePreview.nodeId }}»</strong>
      <p>Входящие связи и инструкции:</p>
      <ul>
        <li v-for="reference in deletePreview.references" :key="reference.path">
          {{ reference.path }} → {{ reference.target }}
        </li>
        <li v-for="file in deletePreview.promptFiles" :key="file.file">
          {{ file.file }} · используют: {{ [...file.selectedUsers, ...file.otherUsers].join(', ') }}
        </li>
      </ul>
      <p v-if="!deletePreview.references.length && !deletePreview.promptFiles.length" class="muted">
        Входящих связей и файлов инструкций нет.
      </p>
      <p class="muted">Связи без новой цели останутся проблемами черновика.</p>
      <UiButton data-test="stage-confirm-delete" @click="remove">Удалить с показанными связями</UiButton>
      <UiButton data-test="stage-cancel-delete" @click="deletePreview = null">Отмена</UiButton>
    </div>
    <ul v-if="issues.length" data-test="stage-issues" role="alert">
      <li v-for="(issue, index) in issues" :key="index">{{ issue.message }}</li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DraftNode } from '../../../../shared/routeDefinition.ts';
import type { RouteDraft } from '../../../../shared/routesEditorContracts.ts';
import type { RouteCommandIssue, RouteCommandResult, RouteCommandScope,
  NewExecutor, NodeInspection } from './routeCommands.ts';
import { addNode, inspectNodeReferences, moveStage, removeNodes, setTransition } from './routeCommands.ts';
import { UiButton, UiSelect } from '../../ui';

const props = defineProps<{
  document: RouteDraft;
  scope: RouteCommandScope;
  selectedNodeId?: string;
}>();
const emit = defineEmits<{
  change: [document: RouteDraft];
  'select-node': [value: { scope: RouteCommandScope; nodeId: string }];
}>();
const newType = ref<NewExecutor>('agent');
const statusOwnerId = ref('');
const outcome = ref('done');
const targetId = ref('');
const targetPhase = ref<'main' | 'tail'>('main');
const issues = ref<RouteCommandIssue[]>([]);
const deletePreview = ref<(NodeInspection & { nodeId: string }) | null>(null);
const machine = computed(() => props.scope.kind === 'bootstrap'
  ? props.document.bootstrap : props.document.routes[props.scope.routeId]?.route);
const nodes = computed(() => {
  if (!machine.value) {
    return [];
  }

  const order = [...(machine.value.sequence.bootstrap ?? []),
    ...(machine.value.sequence.main ?? []), ...(machine.value.sequence.tail ?? [])];
  const byId = new Map(machine.value.nodes.map((node) => [node.id, node]));
  const ordered = order.map((id) => byId.get(id)).filter((node): node is DraftNode => !!node);

  return [...ordered, ...machine.value.nodes.filter((node) => !order.includes(node.id))];
});
const executableNodes = computed(() => nodes.value.filter((node) => node.executor !== 'status'));
const selectedNode = computed(() => nodes.value.find((node) => node.id === props.selectedNodeId) ?? null);
const outcomes = computed(() => Object.keys(selectedNode.value?.on ?? {}));

function select(nodeId: string): void {
  deletePreview.value = null;
  emit('select-node', { scope: props.scope, nodeId });
}

function plainDocument(): RouteDraft {
  return JSON.parse(JSON.stringify(props.document)) as RouteDraft;
}

/**
 * Показывает ошибки команды или отправляет изменённый черновик.
 * Операции учитывают порядок стадий и связанные переходы графа.
 */
function apply(result: RouteCommandResult, input: RouteDraft): boolean {
  issues.value = result.issues;

  if (result.draft === input) {
    return false;
  }

  emit('change', result.draft);

  return true;
}

/**
 * Выделяет неповторяющийся ключ запуска нового узла.
 * Операции учитывают порядок стадий и связанные переходы графа.
 */
function allocateKey(suggested: string, used: ReadonlySet<string>): string {
  if (!used.has(suggested)) {
    return suggested;
  }

  for (let index = 2; index < 10_000; index++) {
    const key = `${suggested}_${index}`;

    if (!used.has(key)) {
      return key;
    }
  }

  return '';
}

function add(): void {
  const input = plainDocument();
  const result = addNode(input, props.scope, newType.value, allocateKey,
    { ownerId: statusOwnerId.value || props.selectedNodeId });

  if (apply(result, input) && result.createdNodeIds[0]) {
    select(result.createdNodeIds[0]);
  }
}

/**
 * Находит позицию выбранного узла в фазе маршрута.
 * Операции учитывают порядок стадий и связанные переходы графа.
 */
function positionOfSelected(): {
  phase: 'bootstrap' | 'main' | 'tail';
  index: number;
  length: number
} | null {
  if (!machine.value || !props.selectedNodeId || selectedNode.value?.executor === 'status') {
    return null;
  }

  for (const phase of ['bootstrap', 'main', 'tail'] as const) {
    const sequence = machine.value.sequence[phase] ?? [];
    const index = sequence.indexOf(props.selectedNodeId);

    if (index >= 0) {
      return {
        phase,
        index,
        length: sequence.length
      };
    }
  }

  return null;
}

function canMove(delta: -1 | 1): boolean {
  const position = positionOfSelected();

  return !!position && position.index + delta >= 0 && position.index + delta < position.length;
}

/**
 * Перемещает узел между соседними позициями стадии.
 * Операции учитывают порядок стадий и связанные переходы графа.
 */
function move(delta: -1 | 1): void {
  const position = positionOfSelected();

  if (!position || !canMove(delta) || !props.selectedNodeId) {
    return;
  }

  const input = plainDocument();

  apply(moveStage(input, props.scope, props.selectedNodeId,
    position.phase, position.index + delta), input);
}

function moveToPhase(): void {
  if (!props.selectedNodeId || props.scope.kind !== 'route') {
    return;
  }

  const input = plainDocument();

  apply(moveStage(input, props.scope, props.selectedNodeId, targetPhase.value,
    input.routes[props.scope.routeId]?.route.sequence[targetPhase.value]?.length ?? 0), input);
}

function connect(): void {
  if (!props.selectedNodeId || !outcome.value || !targetId.value) {
    return;
  }

  const input = plainDocument();

  apply(setTransition(input, props.scope, props.selectedNodeId,
    outcome.value, { next: targetId.value }), input);
}

function previewDelete(): void {
  if (!props.selectedNodeId) {
    return;
  }

  deletePreview.value = { nodeId: props.selectedNodeId,
    ...inspectNodeReferences(props.document, props.scope, [props.selectedNodeId]) };
}

/**
 * Удаляет узел после просмотра затронутых ссылок.
 * Операции учитывают порядок стадий и связанные переходы графа.
 */
function remove(): void {
  if (!deletePreview.value) {
    return;
  }

  const input = plainDocument();
  const result = removeNodes(input, props.scope, [deletePreview.value.nodeId]);

  deletePreview.value = null;

  if (apply(result, input)) {
    const next = props.scope.kind === 'bootstrap'
      ? result.draft.bootstrap : result.draft.routes[props.scope.routeId]?.route;

    emit('select-node', { scope: props.scope,
      nodeId: next?.nodes.find((node) => node.executor !== 'status')?.id ?? '' });
  }
}

/**
 * Обрабатывает клавиши списка, не перехватывая ввод в Monaco.
 * Операции учитывают порядок стадий и связанные переходы графа.
 */
function onKeydown(event: KeyboardEvent): void {
  // Monaco и поля ввода владеют своими сочетаниями клавиш.
  if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey) {
    return;
  }
  if (event.key === 'Insert') {
    add();
  }
  else if (event.key === 'Delete') {
    previewDelete();
  }
  else if (event.altKey && event.key === 'ArrowUp') {
    move(-1);
  }
  else if (event.altKey && event.key === 'ArrowDown') {
    move(1);
  }
  else {
    return;
  }

  event.preventDefault();
}

watch(() => props.selectedNodeId, () => {
  outcome.value = Object.keys(selectedNode.value?.on ?? {})[0] ?? '';
  targetId.value = '';

  if (selectedNode.value?.phase === 'main' || selectedNode.value?.phase === 'tail') {
    targetPhase.value = selectedNode.value.phase;
  }
});
</script>

<style scoped>
.route-stage-list { display: grid; gap: 10px; min-width: 0; padding: 12px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.route-stage-list:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.route-stage-list__tools { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
.route-stage-list__tools label { display: grid; gap: 3px; font-size: 12px; }
.route-stage-list__rows { display: flex; flex-wrap: wrap; gap: 6px; padding: 0;
  margin: 0; list-style: none; }
.route-stage-list__preview { border: 1px solid var(--line); border-radius: 6px; padding: 10px; }
.route-stage-list__preview p { margin: 6px 0; }
</style>
