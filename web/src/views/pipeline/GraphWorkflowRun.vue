<template>
  <section class="gw-run">
    <FactoryGraph
      :graph="graphView"
      keep-positions
      interactive
      :selected-node="selected"
      @node="onGraphNode"
    />
    <section v-if="selected && selectedNode" class="gw-details" :data-workflow-selection="selected">
      <header class="gw-details__head">
        <h3>{{ selectedNode.title }}</h3>
        <span class="gw-status">{{ statusLabel }}</span>
        <span v-if="errorLabel" class="gw-error" data-workflow-error>{{ errorLabel }}</span>
      </header>
      <div v-if="details" class="gw-rows">
        <article v-for="row in details.rows" :key="row.key" class="gw-row">
          <h4>{{ row.title }}</h4>
          <p>{{ row.text }}</p>
          <button
            v-for="mark in row.sources ?? []"
            :key="mark.inputKey + ':' + mark.line"
            type="button"
            class="gw-source"
            @click="openSource(mark)"
          >{{ sourceLabel(mark) }}</button>
        </article>
        <p v-if="details.attempts" class="gw-attempts">{{ t('core.workflowAttempts', { count: details.attempts }) }}</p>
      </div>
      <div v-if="source" class="gw-source-view">
        <h4>{{ source.name }}</h4>
        <pre v-if="!source.segments" class="gw-source-text"><span
          v-for="(line, index) in sourceLines"
          :key="index"
          :data-workflow-source-line="index + 1"
          :class="{ 'gw-line-active': index + 1 === activeLine }"
        >{{ line }}</span></pre>
        <pre v-else class="gw-source-text"><span
          v-for="segment in source.segments"
          :key="segment.line"
          :data-workflow-source-line="segment.line"
          :class="{ 'gw-line-active': segment.line === activeLine }"
        >{{ segment.text }}</span></pre>
      </div>
      <footer class="gw-actions">
        <UiButton
          v-if="selectedNode.status === 'failed'"
          data-workflow-retry
          :disabled="busy"
          @click="emitAction({ nodeId: selected, generation: selectedNode.generation, action: 'retry' })"
        >{{ t('core.workflowRetry') }}</UiButton>
        <template v-if="approvalPending">
          <UiButton
            v-if="details?.approval?.reviewActions?.approve"
            data-workflow-approve
            :disabled="busy"
            @click="decide('approve')"
          >{{ t('core.workflowApprove') }}</UiButton>
          <label v-if="reviewTargets.length > 1" class="gw-field">
            {{ t('core.workflowRejectTarget') }}
            <UiSelect v-model="rejectTarget" data-workflow-reject-target>
              <option v-for="target in reviewTargets" :key="target.id" :value="target.id">{{ target.title }}</option>
            </UiSelect>
          </label>
          <UiTextarea v-model="comment" data-workflow-comment :placeholder="t('core.workflowComment')" />
          <UiButton
            data-workflow-reject
            :disabled="busy || !comment.trim()"
            @click="decide('reject')"
          >{{ rejectLabel }}</UiButton>
        </template>
        <UiButton
          v-if="run.status === 'running' || run.status === 'waiting'"
          data-workflow-pause
          variant="ghost"
          :disabled="busy"
          @click="emitAction({ action: 'pause' })"
        >{{ t('core.workflowPause') }}</UiButton>
        <UiButton
          v-if="run.status === 'paused'"
          data-workflow-resume
          variant="ghost"
          :disabled="busy"
          @click="emitAction({ action: 'resume' })"
        >{{ t('core.workflowResume') }}</UiButton>
        <UiButton data-workflow-result-more variant="ghost" @click="emit('result')">{{ t('core.workflowResultMore') }}</UiButton>
      </footer>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { t, UiButton, UiSelect, UiTextarea } from '../../ui';
import type { MessageKey } from '../../../../shared/i18n/catalogs.ts';
import FactoryGraph from './FactoryGraph.vue';
import { workflowGraph } from '../../shared/graphWorkflowView.ts';
import { api } from '../../shared/apiClient.ts';
import type {
  WorkflowNodeView, WorkflowRunGraph, WorkflowSource,
} from '../../../../shared/pipeline/graphWorkflowContracts.ts';
import type {
  WorkflowInputSource, WorkflowNodeDetails, WorkflowReviewTarget,
} from '../../stores/graphWorkflows.ts';

const props = withDefaults(defineProps<{
  run: WorkflowRunGraph;
  selectionDetails?: WorkflowNodeDetails | null;
  busy?: boolean;
}>(), {
  selectionDetails: null,
  busy: false,
});

const emit = defineEmits<{
  select: [nodeId: string];
  action: [payload: Record<string, unknown>];
  result: [];
}>();

const selected = ref<string | null>(null);
const expanded = ref<Set<string>>(new Set());
const openedByUser = new Map<string, boolean>();
const comment = ref('');
const rejectTarget = ref('');
const source = ref<WorkflowInputSource | null>(null);
const activeLine = ref<number | null>(null);

const statusKeys = {
  pending: 'core.workflowStatusPending',
  ready: 'core.workflowStatusReady',
  running: 'core.workflowStatusRunning',
  waiting: 'core.workflowStatusWaiting',
  done: 'core.workflowStatusDone',
  failed: 'core.workflowStatusFailed',
  skipped: 'core.workflowStatusSkipped',
  blocked: 'core.workflowStatusBlocked',
} as const;

const errorKeys: Record<string, MessageKey> = {
  run_failed: 'core.workflowErrorRunFailed',
  bad_model_result: 'core.workflowErrorBadModelResult',
  bad_plan: 'core.workflowErrorBadPlan',
  model_unavailable: 'core.workflowErrorModelUnavailable',
  input_limit: 'core.workflowErrorInputLimit',
  output_limit: 'core.workflowErrorOutputLimit',
  node_limit: 'core.workflowErrorNodeLimit',
  snapshot_limit: 'core.workflowErrorSnapshotLimit',
  interrupted: 'core.workflowErrorInterrupted',
  repeat_exhausted: 'core.workflowErrorRepeatExhausted',
  threshold_unreachable: 'core.workflowErrorThresholdUnreachable',
  dependency_failed: 'core.workflowErrorDependencyFailed',
  rejected: 'core.workflowErrorRejected',
  operation_limit: 'core.workflowErrorOperationLimit',
  graph_broken: 'core.workflowErrorGraphBroken',
  empty_transcript: 'core.workflowErrorEmptyTranscript',
};

const byId = computed(() => new Map(props.run.nodes.map((node) => [node.id, node])));
const selectedNode = computed(() => (selected.value ? byId.value.get(selected.value) ?? null : null));
const details = computed(() => {
  const value = props.selectionDetails;

  return value && value.id === selected.value && value.generation === selectedNode.value?.generation
    && value.revision === props.run.revision ? value : null;
});
const approvalPending = computed(() => selectedNode.value?.kind === 'approval'
  && selectedNode.value.status === 'waiting' && details.value?.approval?.state === 'pending');
const reviewTargets = computed<WorkflowReviewTarget[]>(
  () => details.value?.approval?.reviewActions?.targets ?? [],
);
const statusLabel = computed(
  () => t(statusKeys[selectedNode.value?.status ?? 'pending'] ?? 'core.workflowStatusPending'),
);
const errorLabel = computed(() => {
  const code = details.value?.errorCode ?? selectedNode.value?.errorCode ?? '';
  const key = errorKeys[code];

  return key ? t(key) : code;
});
const rejectLabel = computed(() => {
  const mode = details.value?.approval?.reviewActions?.rejectMode ?? 'close';
  const target = reviewTargets.value.find(
    (item) => item.id === (rejectTarget.value || reviewTargets.value[0]?.id),
  );

  if (mode === 'close') {
    return t('core.workflowRejectClose');
  }

  return target?.deliversFeedback ? t('core.workflowRejectReturn') : t('core.workflowRejectLocal');
});
const sourceLines = computed(() => (source.value?.text ?? '').split('\n'));

function isGroup(node: WorkflowNodeView): boolean {
  return node.kind === 'forEach' || node.kind === 'call' || node.kind === 'repeat';
}

/**
 * Подпись группы считает терминальные и активные листья по фактическим детям.
 * Без снимка счётчиков итоги собираются обходом членов группы.
 */
function formatGroup(node: WorkflowNodeView): string {
  if (!node.members.length) {
    return node.status === 'done' ? t('core.workflowGroupEmpty') : t('core.workflowGroupAwaiting');
  }

  const counts = node.counts ?? {
    total: node.members.length,
    done: 0,
    running: 0,
    failed: 0,
  };

  if (!node.counts) {
    for (const id of node.members) {
      const member = byId.value.get(id);

      if (!member || member.status === 'done' || member.status === 'skipped') {
        counts.done += 1;
      } else if (member.status === 'failed' || member.status === 'blocked') {
        counts.failed += 1;
      } else if (member.status !== 'pending') {
        counts.running += 1;
      }
    }
  }

  return t('core.workflowGroupCounts', {
    total: counts.total,
    done: counts.done,
    running: counts.running,
    failed: counts.failed,
    pending: counts.total - counts.done - counts.running - counts.failed,
  });
}

const graphView = computed(() => workflowGraph(props.run, expanded.value, formatGroup));

/**
 * Новый снимок раскрывает малые группы без сброса выбора и масштаба.
 * Явное решение человека о сворачивании сохраняется между снимками.
 */
watch(() => props.run, (run) => {
  const next = new Set(expanded.value);

  for (const node of run.nodes) {
    if (!isGroup(node)) {
      continue;
    }
    if (openedByUser.has(node.id)) {
      if (openedByUser.get(node.id)) {
        next.add(node.id);
      } else {
        next.delete(node.id);
      }

      continue;
    }
    if (node.members.length >= 1 && node.members.length <= 4) {
      next.add(node.id);
    } else {
      next.delete(node.id);
    }
  }

  expanded.value = next;

  if (selected.value && !byId.value.has(selected.value)) {
    const parentId = selected.value.split('.').slice(0, -2).join('.');

    selected.value = byId.value.has(parentId) ? parentId : null;
  }
}, { immediate: true });

watch(() => props.run.revision, () => {
  if (selected.value && !details.value) {
    emit('select', selected.value);
  }
});

/**
 * Клик по группе переключает раскрытие и запоминает решение человека.
 * Выбор узла передаётся наверх в любом случае.
 */
function selectNode(id: string): void {
  const node = byId.value.get(id);

  if (node && isGroup(node)) {
    const next = new Set(expanded.value);
    const open = !next.has(id);

    if (open) {
      next.add(id);
    } else {
      next.delete(id);
    }

    openedByUser.set(id, open);
    expanded.value = next;
  }

  selected.value = id;
  emit('select', id);
}

function onGraphNode(event: { id: string }): void {
  selectNode(event.id);
}

/**
 * Открытие ошибки/ворот из сводки раскрывает предков нужного ID.
 * Раскрытие предков запоминается как явное решение человека.
 */
function openNode(id: string): void {
  const next = new Set(expanded.value);
  let node = byId.value.get(id);

  while (node?.parent) {
    next.add(node.parent);
    openedByUser.set(node.parent, true);
    node = byId.value.get(node.parent);
  }

  expanded.value = next;
  selected.value = id;
  emit('select', id);
}

function emitAction(payload: Record<string, unknown>): void {
  emit('action', { expectedRevision: props.run.revision, ...payload });
}

/**
 * Решение относится к тексту открытой панели и его ревизии.
 * Пока новые детали не загружены, обе операции недоступны.
 */
function decide(action: 'approve' | 'reject'): void {
  const shown = details.value;
  const actions = shown?.approval?.reviewActions;

  if (!shown || !actions || !approvalPending.value || props.busy) {
    return;
  }
  if (action === 'approve' && !actions.approve) {
    return;
  }

  const target = actions.targets.find((item) => item.id === rejectTarget.value) ?? actions.targets[0];

  emit('action', {
    expectedRevision: shown.revision,
    nodeId: shown.id,
    generation: shown.generation,
    action,
    ...(action === 'reject' ? { target: target?.id ?? '', comment: comment.value } : {}),
  });
}

/**
 * Подпись источника дополняет номер строки временем в формате мм:сс.
 * Без отметки времени остаётся только номер строки.
 */
function sourceLabel(mark: WorkflowSource): string {
  const line = t('core.workflowSourceLine', { line: mark.line });

  if (mark.timeMs === undefined) {
    return line;
  }

  const total = Math.max(0, Math.floor(mark.timeMs / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');

  return `${line} · ${mm}:${ss}`;
}

async function openSource(mark: WorkflowSource): Promise<void> {
  activeLine.value = mark.line;

  const value = await api.get(
    `/api/graph-workflows/runs/${props.run.id}/inputs/${encodeURIComponent(mark.inputKey)}`,
  ) as WorkflowInputSource;

  source.value = value;
}

defineExpose({
  openNode,
  selected,
  expanded,
});
</script>

<style scoped>
.gw-run {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gw-details {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--ui-border, #d0d7de);
  border-radius: 8px;
}

.gw-details__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.gw-error {
  color: var(--ui-danger, #b42318);
}

.gw-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gw-source {
  margin-right: 8px;
  padding: 2px 6px;
  border: 1px solid var(--ui-border, #d0d7de);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.gw-source-text span {
  display: block;
  white-space: pre-wrap;
}

.gw-line-active {
  background: var(--ui-accent-soft, #fff8c5);
}

.gw-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.gw-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>