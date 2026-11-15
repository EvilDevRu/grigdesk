<template>
  <div class="route-editor-workspace__main">
    <RouteCanvas :document="document" :scope="scope" :selected-node-id="selectedNodeId"
                 :focused-issue="focusedIssue" :highlight-selected-edges="highlighted === selectedNodeId"
                 @add-at="openAdd" @select-node="emit('select-node', $event)" @change="emit('change', $event)" />
    <div class="route-editor-workspace__stages">
      <RouteStageList ref="stageList" :document="document" :scope="scope"
                      :selected-node-id="selectedNodeId" wizard-enabled
                      @open-wizard="wizardOpen = true" @select-node="emit('select-node', $event)"
                      @change="emit('change', $event)" />
    </div>
    <RouteStageWizard v-if="wizardOpen" :document="document" :scope="scope"
                      :selected-node-id="selectedNodeId" :capabilities="capabilities"
                      @close="wizardOpen = false" @empty="addEmpty" @change="inserted" />
    <RouteAddNodeDialog v-if="addPoint" :roles="roleCatalog" :loading="rolesLoading"
                    :error="rolesError" :command-error="addIssue"
                    :unavailable-role-ids="unavailableRoleIds" @close="closeAdd"
                    @retry="retryAdd" @choose="applyAdd" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import type { RouteDraft, RouteEditorInfo, RouteEditorIssue }
  from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteCommandScope } from './routeCommands.ts';
import { routesApi } from '../../shared/routesApi.ts';
import RouteAddNodeDialog from './RouteAddNodeDialog.vue';
import { addNodeAtPoint } from './routeCommands.ts';
import type { NodeCanvasPoint } from './routeCommands.ts';
import type { StageRoleTemplate, StageRoleAnswers }
  from '../../../../shared/pipeline/routeStageWizardContracts.ts';
import type { WizardCapabilities } from './routeWizardTemplates.ts';
import { plainRouteValue } from './routeCanvasGeometry.ts';
import { t } from '../../ui';
import RouteCanvas from './RouteCanvas.vue';
import RouteStageList from './RouteStageList.vue';
import RouteStageWizard from './RouteStageWizard.vue';

const props = defineProps<{
  profile: string;
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


const BUILTIN_CAPABILITIES: WizardCapabilities = {
  schema: 1,
  commands: [],
  contextSections: [],
  filesystem: [],
  timeoutClasses: [],
  retryStrategies: [],
};
const addPoint = ref<NodeCanvasPoint | null>(null);
const roleCatalog = ref<StageRoleTemplate[]>([]);
const rolesLoading = ref(false);
const rolesError = ref(false);
const addIssue = ref('');
let roleRequest = 0;

const unavailableRoleIds = computed(() => props.capabilities?.commands.length
  ? [] : ['review', 'command']);

/**
 * Закрытие отменяет право позднего ответа менять диалог следующего открытия.
 * Данные черновика и применённая история этим действием не затрагиваются.
 */
function closeAdd(): void {
  roleRequest += 1;
  addPoint.value = null;
  rolesLoading.value = false;
  rolesError.value = false;
  addIssue.value = '';
}

/**
 * Каталог запрашивается по профилю проекта и имеет loading/error/retry состояния.
 * Поколение запроса отсекает ответ закрытого диалога и прежнего адресата.
 */
async function openAdd(point: NodeCanvasPoint): Promise<void> {
  if (props.scope.kind !== 'route') {
    return;
  }

  const request = ++roleRequest;


  addPoint.value = { ...point };
  roleCatalog.value = [];
  rolesLoading.value = true;
  rolesError.value = false;
  addIssue.value = '';

  try {
    const catalog = await routesApi.stageRoles(props.profile);

    if (request === roleRequest && addPoint.value) {
      roleCatalog.value = catalog.roles;
    }
  } catch {
    if (request === roleRequest && addPoint.value) {
      rolesError.value = true;
    }
  } finally {
    if (request === roleRequest) {
      rolesLoading.value = false;
    }
  }
}

function retryAdd(): void {
  if (addPoint.value) {
    void openAdd(addPoint.value);
  }
}

/**
 * Передаёт plain снимки документа и шаблона в команды с structuredClone.
 * Отказ оставляет диалог и текст на месте; успех — одно изменение истории и выбор узла.
 */
function applyAdd(template: StageRoleTemplate, answers: StageRoleAnswers): void {
  if (!addPoint.value || rolesLoading.value || rolesError.value) {
    return;
  }

  const input = plainRouteValue(props.document);
  const result = addNodeAtPoint(input, props.scope, { ...addPoint.value },
    plainRouteValue(template), plainRouteValue(answers),
    plainRouteValue(props.capabilities ?? BUILTIN_CAPABILITIES));
  const issue = result.issues[0];

  if (issue) {
    const reasonKeys = {
      after_delivery: 'core.stageWizardReason_after_delivery',
      loop_pair: 'core.stageWizardReason_loop_pair',
      success_required: 'core.stageWizardReason_success_required',
      role_duplicate: 'core.stageWizardReason_role_duplicate',
      recheck_unavailable: 'core.stageWizardReason_recheck_unavailable',
      role_invalid: 'core.stageWizardReason_role_invalid',
      route_missing: 'core.stageWizardReason_route_missing',
      prompt_missing: 'core.stageWizardReason_prompt_missing',
      prompt_limit_exceeded: 'core.stageWizardReason_prompt_limit_exceeded',
    } as const;
    const key = Object.hasOwn(reasonKeys, issue.code)
      ? reasonKeys[issue.code as keyof typeof reasonKeys] : null;

    addIssue.value = key ? t(key) : issue.message;

    return;
  }

  if (result.draft !== input && result.createdNodeIds[0]) {
    const created = result.createdNodeIds[0];


    closeAdd();
    inserted(result.draft, created);
  }
}

watch(() => `${props.profile}|${props.document.id}|${props.scope.kind}|${
  props.scope.kind === 'route' ? props.scope.routeId : ''
}`, closeAdd);
onBeforeUnmount(closeAdd);

</script>

<style scoped>
.route-editor-workspace__stages {
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
</style>
