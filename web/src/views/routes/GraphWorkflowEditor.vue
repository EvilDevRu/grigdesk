<template>
  <section class="gw-editor">
    <header class="gw-editor__head">
      <span data-workflow-title>
        <UiInput
          v-model="draft.title"
          :aria-label="t('core.workflowTitle')"
        />
      </span>
      <UiSelect v-model="draft.inputKind" data-workflow-input-kind :aria-label="t('core.workflowInputKind')">
        <option value="documents">{{ t('core.workflowInputDocuments') }}</option>
        <option value="transcript">{{ t('core.workflowInputTranscript') }}</option>
      </UiSelect>
      <UiButton data-workflow-add @click="addStep">{{ t('core.workflowAddStep') }}</UiButton>
    </header>

    <p v-if="conflict" class="gw-editor__conflict" role="alert">{{ t('core.workflowConflict') }}</p>
    <p v-if="serverError" class="gw-editor__error" role="alert">{{ serverError }}</p>

    <div class="gw-editor__body">
      <GraphWorkflowScopeFields
        :scope="draft.scope"
        :depth="0"
        @update:scope="draft.scope = $event"
        :subflow-scope="subflowScope"
      />
      <FactoryGraph
        :graph="preview"
        reference
        interactive
        keep-positions
        :selected-node="selectedStep"
        @node="selectedStep = $event.id"
      />
    </div>

    <footer class="gw-editor__actions">
      <UiButton data-workflow-save :disabled="busy" @click="emit('save', clone(draft))">{{ t('core.workflowSave') }}</UiButton>
      <UiButton v-if="conflict" data-workflow-save-copy :disabled="busy" @click="emit('save-copy', clone(draft))">
        {{ t('core.workflowSaveCopy') }}
      </UiButton>
      <UiButton variant="ghost" data-workflow-reload @click="emit('reload')">{{ t('core.workflowClose') }}</UiButton>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue';

import { t, UiButton, UiInput, UiSelect } from '../../ui';
import FactoryGraph from '../pipeline/FactoryGraph.vue';
import GraphWorkflowScopeFields from './GraphWorkflowScopeFields.vue';
import type { FactoryGraphData } from '../../../../shared/pipeline/factoryGraphContracts.ts';
import type {
  Workflow, WorkflowScope, WorkflowStep,
} from '../../../../shared/pipeline/graphWorkflowContracts.ts';

const props = defineProps<{
  document: Workflow;
  busy?: boolean;
  conflict?: boolean;
  serverError?: string | null;
}>();

const emit = defineEmits<{
  save: [document: Workflow];
  'save-copy': [document: Workflow];
  reload: [];
}>();

const draft = ref<Workflow>(clone(props.document));
const selectedStep = ref<string | null>(null);
const subflowScope = ref<WorkflowScope | null>(null);

/**
 * Копия документа для сохранения не делит ссылок с формой.
 * JSON-обход снимает reactive-обёртки любой вложенности и лишние undefined.
 */
function clone(value: Workflow): Workflow {
  return JSON.parse(JSON.stringify(toRaw(value))) as Workflow;
}

watch(() => props.document, (value) => {
  draft.value = clone(value);
}, { deep: false });

/**
 * Новый шаг получает первый свободный целый ID step-N.
 * Поля создаются минимальным допустимым набором для вида input.
 */
function addStep(): void {
  let index = 1;

  const scope = toRaw(draft.value.scope);

  while (scope.steps.some((step) => step.id === 'step-' + index)) {
    index += 1;
  }

  const step: WorkflowStep = {
    id: 'step-' + index,
    title: t('core.workflowStepLabel') + ' ' + index,
    kind: 'input',
  };

  draft.value.scope = {
    ...scope,
    steps: [...scope.steps, step],
  };
}

/** Preview рисует локальные зависимости формы без исполнения и координат движка. */
const preview = computed<FactoryGraphData>(() => {
  const graph: FactoryGraphData = {
    pos: {},
    nodes: {},
    edges: [],
    statuses: {},
    nodeOrigins: {},
  };

  draft.value.scope.steps.forEach((step, index) => {
    graph.pos[step.id] = [140 + (index % 3) * 220, 55 + Math.floor(index / 3) * 150];
    graph.nodes[step.id] = [
      step.kind === 'approval' ? 'human' : step.kind === 'agent' ? 'agent' : 'code',
      step.title,
      '',
    ];
    graph.nodeOrigins![step.id] = {
      scope: 'route',
      originId: step.id,
      executable: true,
    };

    for (const need of step.needs ?? []) {
      if (graph.pos[need]) {
        graph.edges.push([need, step.id, '', 'pass', '']);
      }
    }
  });

  return graph;
});

defineExpose({
  draft,
  subflowScope,
  selectedStep,
});
</script>

<style scoped>
.gw-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gw-editor__head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.gw-editor__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.gw-editor__conflict {
  color: var(--ui-warning, #9a6700);
}

.gw-editor__error {
  color: var(--ui-danger, #b42318);
}

.gw-editor__actions {
  display: flex;
  gap: 8px;
}

@media (max-width: 600px) {
  .gw-editor__body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>