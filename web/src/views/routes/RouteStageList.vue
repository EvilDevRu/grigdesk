<template>
  <section class="route-stage-list ui-workspace-section" tabindex="0" :aria-label="t('core.routeSpisokEtapovMarshruta')"
           @keydown="onKeydown">
    <UiPaneHeader>
      <template #title><h3>{{ t('core.routeEtapy') }}</h3></template>
      <template #meta>{{ nodes.length }}</template>
    </UiPaneHeader>
    <div class="ui-workspace-section__body">
      <ol class="route-stage-list__rows">
        <li v-for="node in nodes" :key="node.id">
          <UiButton data-context="workspace-catalog-row" variant="ghost" :data-test="`stage-select-${node.id}`" :pressed="selectedNodeId === node.id"
                    @click="select(node.id)"><span class="route-stage-list__name">{{ node.label || node.id }}<small>{{ executorNames[node.executor] ?? node.executor }} · {{ phaseNames[node.phase] ?? node.phase }}</small></span></UiButton>
        </li>
      </ol>
      <details class="route-stage-list__manage ui-workspace-disclosure">
        <summary>{{ t('core.routeUpravlenieEtapami') }}</summary>
        <div class="ui-workspace-section__body">
          <small class="muted">{{ t('core.routeInsertDobavitAltPeremestit') }}</small>
          <div class="route-stage-list__tools">
            <label>{{ t('core.routeTipNovogoEtapa') }} <UiSelect data-test="stage-new-type" :model-value="newType"
                        @update:model-value="newType = String($event) as NewExecutor">
                <option value="agent">{{ t('core.routeAgentIi') }}</option><option value="command">{{ t('core.interventionCommand') }}</option>
                <option value="gate">{{ t('core.routeReshenieCheloveka') }}</option><option value="status">{{ t('core.codeReviewFilterStatus') }}</option>
              </UiSelect>
            </label>
            <UiField v-if="newType === 'status'" :label="t('core.routeVladelets')"
                     :help="t('core.routeStageListTheStageThatProducesThisStatus')">
              <UiSelect data-test="stage-owner" :model-value="statusOwnerId"
                        @update:model-value="statusOwnerId = String($event)">
                <option value="">{{ t('core.arbiterTarget') }}</option>
                <option v-for="node in executableNodes" :key="node.id" :value="node.id">
                  {{ node.label || node.id }}
                </option>
              </UiSelect>
            </UiField>
            <UiButton data-context="workspace-form" variant="ghost" data-test="stage-add" @click="requestAdd">{{ t('core.stageWizardApply') }}</UiButton>
          </div>

          <div class="route-stage-list__tools">
            <UiIconButton data-context="workspace-form" data-test="stage-up" :label="t('core.routeVyshe')"
                          v-tooltip="t('core.routePeremestitEtapVyshe')" :disabled="!canMove(-1)" @click="move(-1)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 19V5m-6 6 6-6 6 6" />
              </svg>
            </UiIconButton>
            <UiIconButton data-context="workspace-form" data-test="stage-down" :label="t('core.routeNizhe')"
                          v-tooltip="t('core.routePeremestitEtapNizhe')" :disabled="!canMove(1)" @click="move(1)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 5v14m-6-6 6 6 6-6" />
              </svg>
            </UiIconButton>
            <UiField v-if="scope.kind === 'route'" :label="t('core.routeFaza')"
                     :help="t('core.routeStageListMainStagesPerformTheTaskFinalization')">
              <UiSelect data-test="stage-phase" :model-value="targetPhase"
                        @update:model-value="targetPhase = String($event) as 'main' | 'tail'">
                <option value="main">{{ t('core.routeOsnovnaya') }}</option><option value="tail">{{ t('core.routeZavershenie') }}</option>
              </UiSelect>
            </UiField>
            <UiButton data-context="workspace-form" variant="ghost" v-if="scope.kind === 'route'" data-test="stage-move-phase"
                      :disabled="!selectedNode || selectedNode.executor === 'status'"
                      @click="moveToPhase">{{ t('core.routePerenestiVFazu') }}</UiButton>
            <UiButton data-context="workspace-form" variant="ghost" data-test="stage-delete" :disabled="!selectedNodeId" @click="previewDelete"> {{ t('core.routeUdalitEtap') }} </UiButton>
          </div>
          <div v-if="selectedNode && selectedNode.executor !== 'status'" class="route-stage-list__tools">
            <UiField :label="t('core.routeIshod')"
                     :help="t('core.routeStageListTheSelectedStageSOutcomeSuch')">
              <UiSelect data-test="stage-outcome" :model-value="outcome"
                        @update:model-value="outcome = String($event)">
                <option v-for="key in outcomes" :key="key" :value="key">{{ key }}</option>
              </UiSelect>
            </UiField>
            <UiField :label="t('core.routeTsel')"
                     :help="t('core.routeStageListTheStageToRunAfterThe')">
              <UiSelect data-test="stage-target" :model-value="targetId"
                        @update:model-value="targetId = String($event)">
                <option value="">{{ t('core.arbiterTarget') }}</option>
                <option v-for="node in executableNodes" :key="node.id" :value="node.id">
                  {{ node.label || node.id }}
                </option>
              </UiSelect>
            </UiField>
            <UiButton data-context="workspace-form" variant="ghost" data-test="stage-connect" :disabled="!outcome || !targetId"
                      @click="connect">{{ t('core.routeSoedinit') }}</UiButton>
          </div>
        </div>
      </details>
      <div v-if="deletePreview" data-test="stage-delete-preview" class="route-stage-list__preview">
        <strong>{{ t('core.routeUdalenie') }}{{ deletePreview.nodeId }}»</strong>
        <p>{{ t('core.routeVhodyaschieSvyaziIInstruktsii') }}</p>
        <ul>
          <li v-for="reference in deletePreview.references" :key="reference.path">
            {{ reference.path }} → {{ reference.target }}
          </li>
          <li v-for="file in deletePreview.promptFiles" :key="file.file">
            {{ file.file }} {{ t('core.routeIspolzuyut') }} {{ [...file.selectedUsers, ...file.otherUsers].join(', ') }}
          </li>
        </ul>
        <p v-if="!deletePreview.references.length && !deletePreview.promptFiles.length" class="muted"> {{ t('core.routeVhodyaschihSvyazeyIFaylov') }} </p>
        <p class="muted">{{ t('core.routeSvyaziBezNovoyTseli') }}</p>
        <UiButton data-context="workspace-form" variant="ghost" data-test="stage-confirm-delete" @click="remove">{{ t('core.routeUdalitSPokazannymiSvyazyami') }}</UiButton>
        <UiButton data-context="workspace-form" variant="ghost" data-test="stage-cancel-delete" @click="deletePreview = null">{{ t('core.cancel') }}</UiButton>
      </div>
      <ul v-if="issues.length" data-test="stage-issues" role="alert">
        <li v-for="(issue, index) in issues" :key="index">{{ issue.message }}</li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DraftNode } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteDraft } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteCommandIssue, RouteCommandResult, RouteCommandScope,
  NewExecutor, NodeInspection } from './routeCommands.ts';
import { addNode, inspectNodeReferences, moveStage, removeNodes, setTransition } from './routeCommands.ts';
import { UiButton, UiField, UiIconButton, UiPaneHeader, UiSelect, vTooltip, t } from '../../ui';

const executorNames: Record<string, string> = {
  get agent() {
    return t('core.chatSettingsAgent');
  },
  get command() {
    return t('core.interventionCommand');
  },
  get gate() {
    return t('core.routeChelovek');
  },
  get status() {
    return t('core.codeReviewFilterStatus');
  },
};
const phaseNames: Record<string, string> = {
  get main() {
    return t('core.routeOsnovnaya');
  },
  get tail() {
    return t('core.routeZavershenie');
  },
  get bootstrap() {
    return t('core.routeRazvedka');
  },
};

const props = defineProps<{
  document: RouteDraft;
  scope: RouteCommandScope;
  selectedNodeId?: string;
  wizardEnabled?: boolean;
}>();
const emit = defineEmits<{
  change: [document: RouteDraft];
  'open-wizard': [];
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

function requestAdd(): void {
  if (props.wizardEnabled && props.scope.kind === 'route') {
    emit('open-wizard');
  } else {
    add();
  }
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
defineExpose({ add });
</script>

<style scoped>
.route-stage-list {
  min-width: 0;
}

.route-stage-list:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.route-stage-list__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 8px;
}

.route-stage-list__tools label {
  display: grid;
  gap: 3px;
  font-size: 12px;
}

.route-stage-list__rows {
  display: grid;
  gap: 2px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.route-stage-list__preview {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 10px;
}

.route-stage-list__preview p {
  margin: 6px 0;
}

.route-stage-list__name {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 2px 8px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.route-stage-list__name small {
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 400;
}

</style>
