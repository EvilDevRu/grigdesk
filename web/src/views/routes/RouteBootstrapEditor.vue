<template>
  <section class="route-bootstrap-editor">
    <header>
      <strong>Начальная разведка</strong>
      <span class="muted">Отдельная машина каталога: её Scout выбирает маршрут до запуска.</span>
    </header>
    <label>Начальный этап
      <UiSelect data-test="bootstrap-entry" :model-value="document.bootstrap.entry ?? ''"
                @update:model-value="changeEntry(String($event ?? ''))">
        <option value="">Не выбран</option>
        <option v-for="node in executableNodes" :key="node.id" :value="node.id">
          {{ node.label || node.id }}
        </option>
      </UiSelect>
    </label>
    <div class="route-bootstrap-editor__workspace">
      <RouteCanvas :document="document" :scope="bootstrapScope" :selected-node-id="activeNodeId"
                   :focused-issue="focusedIssue" @select-node="emit('select-node', $event)"
                   @change="emit('change', $event)" />
      <div class="route-bootstrap-editor__sidebar">
        <RouteStageList :document="document" :scope="bootstrapScope"
                        :selected-node-id="activeNodeId" @select-node="emit('select-node', $event)"
                        @change="emit('change', $event)" />
        <div v-if="activeNodeId" class="route-bootstrap-editor__inspectors">
          <RouteNodeInspector :document="document" :scope="bootstrapScope"
                              :node-id="activeNodeId" :capabilities="capabilities ?? null"
                              @change="emit('change', $event)"
                              @select-node="emit('select-node', $event)" />
          <RouteTransitionInspector :document="document" :scope="bootstrapScope"
                                    :node-id="activeNodeId" @change="emit('change', $event)" />
        </div>
      </div>
    </div>
    <RoutePromptEditor v-if="activeNode?.prompt" :document="document" route-id=""
                       scope="bootstrap" :node-id="activeNodeId"
                       :focus-path="focusedIssue?.path ?? ''"
                       @change="changePrompt" @end-history-group="emit('end-history-group')"
                       @save="emit('save')" />
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DraftMachine } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteDraft, RouteEditorInfo,
  RouteEditorIssue } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteCommandScope } from './routeCommands.ts';
import { UiSelect } from '../../ui';
import RouteCanvas from './RouteCanvas.vue';
import RouteStageList from './RouteStageList.vue';
import RouteNodeInspector from './RouteNodeInspector.vue';
import RouteTransitionInspector from './RouteTransitionInspector.vue';
import RoutePromptEditor from './RoutePromptEditor.vue';

const bootstrapScope: RouteCommandScope = { kind: 'bootstrap' };
const props = defineProps<{
  document: RouteDraft;
  selectedNodeId?: string;
  focusedIssue?: RouteEditorIssue | null;
  capabilities?: RouteEditorInfo['capabilities'] | null;
}>();
const emit = defineEmits<{
  change: [document: RouteDraft];
  'prompt-change': [value: {
    bootstrap: DraftMachine;
    prompts: Record<string, string>;
    historyGroup?: string
  }];
  'select-node': [value: { scope: RouteCommandScope; nodeId: string }];
  'end-history-group': [];
  save: [];
}>();
const executableNodes = computed(() => props.document.bootstrap.nodes.filter((node) =>
  node.executor !== 'status'));
const activeNodeId = computed(() => props.selectedNodeId || executableNodes.value[0]?.id || '');
const activeNode = computed(() => props.document.bootstrap.nodes.find((node) =>
  node.id === activeNodeId.value));

/**
 * Выбирает начальный узел графа разведки.
 * Изменение остаётся частью общего черновика каталога.
 */
function changeEntry(nodeId: string): void {
  if (nodeId && !executableNodes.value.some((node) => node.id === nodeId)) {
    return;
  }

  const copy = JSON.parse(JSON.stringify(props.document)) as RouteDraft;

  copy.bootstrap.entry = nodeId || null;
  emit('change', copy);
}

function changePrompt(value: { bundle: { route: DraftMachine; prompts: Record<string, string> };
  historyGroup?: string }): void {
  emit('prompt-change', {
    bootstrap: value.bundle.route,
    prompts: value.bundle.prompts,
    historyGroup: value.historyGroup
  });
}
</script>

<style scoped>
.route-bootstrap-editor { display: grid; gap: 10px; min-width: 0; }
.route-bootstrap-editor header { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.route-bootstrap-editor label { display: grid; gap: 4px; max-width: 320px; }
/* Как в редакторе маршрута: схема во всю ширину, под ней список этапов и инспекторы. */
.route-bootstrap-editor__workspace { display: grid; grid-template-columns: minmax(0, 1fr);
  gap: 10px; min-width: 0; }
.route-bootstrap-editor__sidebar { display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 420px); align-items: start;
  gap: 10px; min-width: 0; }
.route-bootstrap-editor__inspectors { display: grid; gap: 10px; min-width: 0; }
@media (max-width: 820px) {
  .route-bootstrap-editor__sidebar { grid-template-columns: 1fr; }
}
</style>
