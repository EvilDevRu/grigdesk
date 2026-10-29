<template>
  <div class="route-editor-workspace__main">
    <RouteCanvas :document="document" :scope="scope" :selected-node-id="selectedNodeId"
                 :focused-issue="focusedIssue" :highlight-selected-edges="highlighted === selectedNodeId"
                 @select-node="emit('select-node', $event)" @change="emit('change', $event)" />
    <div class="route-editor-workspace__stages">
      <RouteStageList ref="stageList" :document="document" :scope="scope"
                      :selected-node-id="selectedNodeId" wizard-enabled
                      @open-wizard="wizardOpen = true" @select-node="emit('select-node', $event)"
                      @change="emit('change', $event)" />
    </div>
    <RouteStageWizard v-if="wizardOpen" :document="document" :scope="scope"
                      :selected-node-id="selectedNodeId" :capabilities="capabilities"
                      @close="wizardOpen = false" @empty="addEmpty" @change="inserted" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

import type { RouteDraft, RouteEditorInfo, RouteEditorIssue }
  from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteCommandScope } from './routeCommands.ts';
import RouteCanvas from './RouteCanvas.vue';
import RouteStageList from './RouteStageList.vue';
import RouteStageWizard from './RouteStageWizard.vue';

const props = defineProps<{
  document: RouteDraft;
  scope: RouteCommandScope;
  selectedNodeId?: string;
  focusedIssue?: RouteEditorIssue | null;
  capabilities: RouteEditorInfo['capabilities'] | null;
}>();
const emit = defineEmits<{
  change: [document: RouteDraft];
  'select-node': [value: { scope: RouteCommandScope; nodeId: string }];
}>();

const stageList = ref<InstanceType<typeof RouteStageList> | null>(null);
const wizardOpen = ref(false);
const highlighted = ref('');

function addEmpty(): void {
  wizardOpen.value = false;
  stageList.value?.add();
}

/**
 * Передаёт весь пакет одним изменением в штатную историю.
 * Выбор нового этапа синхронизирует адрес и инспектор после применения снимка.
 */
function inserted(document: RouteDraft, nodeId: string): void {
  highlighted.value = nodeId;
  emit('change', document);
  emit('select-node', { scope: props.scope, nodeId });
}

watch(() => props.selectedNodeId, (nodeId, previous) => {
  if (previous === highlighted.value && nodeId !== highlighted.value) {
    highlighted.value = '';
  }
});
</script>

<style scoped>
.route-editor-workspace__stages {
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
</style>
