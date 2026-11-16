<template>
  <UiDialog open size="workspace" :title="t('core.stageWizardTitle')" @close="emit('close')">
    <div class="stage-wizard">
      <p v-if="loading" role="status">{{ t('core.stageWizardLoading') }}</p>
      <p v-if="catalogFailed" role="alert">{{ t('core.stageWizardCatalogError') }}</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="step === 1">
        <p>{{ t('core.stageWizardRoleQuestion') }}</p>
        <div class="stage-wizard__roles">
          <div v-for="role in visibleRoles" :key="role.id">
            <UiButton block wrap :data-test="`wizard-role-${role.id}`" :disabled="Boolean(roleReason(role))"
                      :pressed="selectedRoleId === role.id" @click="chooseRole(role)">
              <span>{{ t(`core.stageWizardRole_${role.id}`) }}</span>
              <small>{{ t(`core.stageWizardHint_${role.id}`) }}</small>
            </UiButton>
            <p v-if="roleReason(role)">{{ reasonText(roleReason(role)) }}</p>
          </div>
        </div>
      </template>
      <template v-else-if="step === 2 && selectedRole">
        <h3>{{ t(`core.stageWizardRole_${selectedRole.id}`) }}</h3>
        <label v-if="selectedRoleId === 'custom'">{{ t('core.stageWizardDescription') }}
          <UiTextarea v-model="answers.description" data-test="wizard-description" />
          <small>{{ t('core.stageWizardDirectText') }}</small>
        </label>
        <p v-if="selectedRoleId === 'human'">{{ t('core.stageWizardHumanSettings') }}</p>
        <template v-else>
          <label>{{ t('core.stageWizardFilesystem') }}
            <UiSelect v-model="answers.filesystem" data-test="wizard-filesystem">
              <option v-for="policy in filesystemChoices" :key="policy" :value="policy">
                {{ filesystemLabel(policy) }}
              </option>
            </UiSelect>
          </label>
          <label v-if="selectedRoleId === 'command' || selectedRoleId === 'review'">
            {{ t('core.stageWizardCommand') }}
            <UiSelect v-model="commandAnswer" data-test="wizard-command" :disabled="reuseReviewCheck">
              <option v-for="command in capabilities?.commands" :key="command.id" :value="command.id">
                {{ commandLabel(command) }}
              </option>
            </UiSelect>
            <small v-if="reuseReviewCheck">{{ t('core.stageWizardReuseCheck') }}</small>
          </label>
          <p v-if="selectedRoleId === 'command'">{{ t('core.stageWizardCommandSettings') }}</p>
          <template v-else>
            <UiCheckbox v-model="answers.services" data-test="wizard-services">
              {{ t('core.stageWizardServices') }}
            </UiCheckbox>
            <UiCheckbox v-model="answers.browser" data-test="wizard-browser">
              {{ t('core.stageWizardBrowser') }}
            </UiCheckbox>
          </template>
          <label>{{ t('core.stageWizardFailure') }}
            <UiSelect v-model="answers.failure" data-test="wizard-failure">
              <option value="return" :disabled="!returnTargets.length">
                {{ t('core.stageWizardReturn') }}
              </option>
              <option value="self-fix" :disabled="answers.filesystem !== 'workspace-write'
                || selectedRoleId === 'command'">{{ t('core.stageWizardSelfFix') }}</option>
              <option value="ask">{{ t('core.stageWizardAsk') }}</option>
            </UiSelect>
          </label>
          <p v-if="machine?.loop">{{ t('core.stageWizardLoopFailure') }}</p>
          <label v-if="answers.failure !== 'ask' && returnTargets.length">
            {{ t('core.stageWizardReturnTarget') }}
            <UiSelect v-model="answers.returnTargetId" data-test="wizard-return-target">
              <option v-for="node in returnTargets" :key="node.id" :value="node.id">
                {{ node.label || node.id }}
              </option>
            </UiSelect>
          </label>
        </template>
        <p v-for="issue in prepared?.issues" :key="issue.code" role="alert">
          {{ reasonText(issue.code) }}
        </p>
      </template>
      <template v-else-if="step === 3">
        <p>{{ t('core.stageWizardPlace') }}</p>
        <label>{{ t('core.stageWizardAfter') }}
          <UiSelect v-model="afterId" data-test="wizard-after">
            <option v-for="place in places" :key="place.afterId" :value="place.afterId"
                    :disabled="Boolean(place.disabledReason)">
              {{ place.label }}{{ place.disabledReason ? t('core.routeDisabledreason', { disabledReason: reasonText(place.disabledReason) }) : '' }}
            </option>
          </UiSelect>
        </label>
        <ul>
          <li v-for="place in unavailablePlaces" :key="place.afterId">
            {{ place.label }}: {{ reasonText(place.disabledReason) }}
          </li>
        </ul>
        <RouteCanvas :document="document" :scope="scope" :selected-node-id="afterId" choose-mode
                     @choose-place="choosePlace" />
        <p v-if="candidate?.createdNodeIds.length && candidate.createdNodeIds.length > 1">
          {{ t('core.stageWizardCompanion') }}: {{ candidate.createdNodeIds.join(' → ') }}
        </p>
      </template>
      <template v-else-if="step === 4">
        <p>{{ t('core.stageWizardAdded') }}</p>
        <RouteCanvas :document="document" :scope="scope" :selected-node-id="insertedId"
                     highlight-selected-edges />
        <RoutePromptPreview v-if="insertedNode?.executor === 'agent'"
                            :result="preview?.result ?? null" :stale="preview?.stale ?? false"
                            :busy="busy || store.promptPreviewBusy" @request="previewPrompt" />
        <p v-else>{{ t('core.stageWizardNoPrompt') }}</p>
        <p v-if="store.promptPreviewError" role="alert">{{ store.promptPreviewError }}</p>
        <RouteSimulation :document="document" :simulation="store.simulation"
                         @start="startSimulation" @step="stepRouteSimulation"
                         @approve="approveRouteSimulation" />
        <p v-if="store.simulationError" role="alert">{{ store.simulationError }}</p>
      </template>
      <div class="stage-wizard__actions">
        <UiButton v-if="step < 4" data-test="wizard-empty" variant="ghost" @click="emit('empty')">
          {{ t('core.stageWizardEmpty') }}
        </UiButton>
        <UiButton data-test="wizard-cancel" variant="ghost" :disabled="busy" @click="emit('close')">
          {{ t('core.stageWizardCancel') }}
        </UiButton>
        <UiButton v-if="step > 1 && step < 4" data-test="wizard-back" @click="step -= 1">
          {{ t('core.stageWizardBack') }}
        </UiButton>
        <UiButton v-if="step < 3" data-test="wizard-next" :disabled="!canContinue" @click="next">
          {{ t('core.stageWizardNext') }}
        </UiButton>
        <UiButton v-if="step === 3" data-test="wizard-apply" :disabled="!canApply" @click="apply">
          {{ t('core.stageWizardApply') }}
        </UiButton>
        <UiButton v-if="step === 4" data-test="wizard-add-more" :disabled="busy" @click="addMore">
          {{ t('core.stageWizardAddMore') }}
        </UiButton>
        <UiButton v-if="step === 4" data-test="wizard-check-publish" :disabled="busy" @click="finish">
          {{ t('core.stageWizardCheckPublish') }}
        </UiButton>
      </div>
    </div>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import type { DraftNode } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteDraft, RouteEditorInfo } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { StageRoleAnswers, StageRoleCatalog, StageRoleId, StageRoleTemplate }
  from '../../../../shared/pipeline/routeStageWizardContracts.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from '../../actions/routes/routesRuntime.ts';
import { prepareStageWizardPublication, saveStageWizardSnapshot } from '../../actions/routes/stageWizard.ts';
import { previewRoutePrompt } from '../../actions/routes/preview.ts';
import { approveRouteSimulation, startRouteSimulation, stepRouteSimulation }
  from '../../actions/routes/simulation.ts';
import { t, UiButton, UiCheckbox, UiDialog, UiSelect, UiTextarea } from '../../ui';
import {
  findStageReviewCheck, insertStageRole, listStageInsertionPlaces, prepareStageRole,
} from './routeCommands.ts';
import type { RouteCommandScope } from './routeCommands.ts';
import { normalizeStageRoleAnswers } from './routeWizardTemplates.ts';
import RouteCanvas from './RouteCanvas.vue';
import RoutePromptPreview from './RoutePromptPreview.vue';
import RouteSimulation from './RouteSimulation.vue';

const props = defineProps<{
  document: RouteDraft;
  scope: RouteCommandScope;
  selectedNodeId?: string;
  capabilities: RouteEditorInfo['capabilities'] | null;
}>();
const emit = defineEmits<{
  close: [];
  empty: [];
  change: [document: RouteDraft, nodeId: string];
}>();

const store = useRoutesStore();
const route = useRoute();
const step = ref(1);
const selectedRoleId = ref<StageRoleId | null>(null);
const answers = ref<StageRoleAnswers>({});
const afterId = ref(props.selectedNodeId ?? '');
const catalog = ref<StageRoleCatalog | null>(null);
const loading = ref(true);
const catalogFailed = ref(false);
const error = ref('');
const busy = ref(false);
const insertedId = ref('');

const address = computed(() => JSON.stringify([
  route.query.profile, route.query.draft, route.query.route, props.document.id,
  props.scope.kind === 'route' ? props.scope.routeId : '',
  store.opened?.profile, store.opened?.draftId, store.opened?.readOnly,
]));
const initialAddress = address.value;
const openRequest = runtimeOf(store).openRequest;
const machine = computed(() => props.scope.kind === 'route'
  ? props.document.routes[props.scope.routeId]?.route : null);
const order = computed(() => [
  ...(machine.value?.sequence.main ?? []), ...(machine.value?.sequence.tail ?? []),
]);
const visibleRoles = computed(() => catalog.value?.roles.filter((role) =>
  role.id !== 'command' || Boolean(props.capabilities?.commands.length)) ?? []);
const selectedRole = computed(() => catalog.value?.roles.find((role) => role.id === selectedRoleId.value));
const returnTargets = computed(() => machine.value?.loop ? []
  : order.value.slice(0, order.value.indexOf(afterId.value) + 1)
  .map((id) => machine.value?.nodes.find((node) => node.id === id))
  .filter((node): node is DraftNode => node !== undefined && node.executor !== 'status'));
const filesystemChoices = computed(() => selectedRoleId.value === 'command'
  ? props.capabilities?.commands.find((command) => command.id === answers.value.commandId)?.filesystem ?? []
  : props.capabilities?.filesystem ?? []);
const prepared = computed(() => selectedRole.value && props.capabilities
  ? prepareStageRole(plain(selectedRole.value), { ...answers.value }, props.capabilities) : null);
const reviewCheck = computed(() => selectedRoleId.value === 'review' && machine.value
  && prepared.value && props.capabilities
  ? findStageReviewCheck(machine.value, afterId.value, prepared.value, props.capabilities) : null);
const reuseReviewCheck = computed(() => Boolean(reviewCheck.value
  && machine.value?.nodes.some((node) => node.id === reviewCheck.value?.id)));
const commandAnswer = computed({
  get: () => (reuseReviewCheck.value ? reviewCheck.value?.commandId : answers.value.commandId) ?? '',
  set: (commandId: string) => {
    answers.value.commandId = commandId;
  },
});
const places = computed(() => prepared.value && props.capabilities
  ? listStageInsertionPlaces(props.document, props.scope, prepared.value, props.capabilities) : []);
const unavailablePlaces = computed(() => places.value.filter((place) => place.disabledReason));
const candidate = computed(() => prepared.value && props.capabilities
  ? insertStageRole(plain(props.document), props.scope, afterId.value,
    prepared.value, props.capabilities) : null);
const canContinue = computed(() => isCurrent() && Boolean(selectedRole.value)
  && (step.value === 1 || !prepared.value?.issues.length));
const canApply = computed(() => isCurrent() && Boolean(candidate.value?.createdNodeIds.length));
const insertedNode = computed(() => machine.value?.nodes.find((node) => node.id === insertedId.value));
const preview = computed(() => store.promptPreview?.nodeId === insertedId.value ? store.promptPreview : null);

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isCurrent(): boolean {
  return initialAddress === address.value && openRequest === runtimeOf(store).openRequest
    && !store.opened?.readOnly;
}

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

const commandLabelKeys = {
  verify: 'core.stageWizardVerify',
  recheck: 'core.stageWizardRecheck',
} as const;

const filesystemLabelKeys = {
  'state-only': 'core.stageWizardRead',
  'transactional-write': 'core.stageWizardTemporaryWrite',
  'workspace-write': 'core.stageWizardWrite',
} as const;

function filesystemLabel(filesystem: string): string {
  const key = filesystemLabelKeys[filesystem as keyof typeof filesystemLabelKeys];

  return key ? t(key) : filesystem;
}

function commandLabel(command: { id: string; label?: string }): string {
  const key = commandLabelKeys[command.id as keyof typeof commandLabelKeys];

  return key ? t(key) : command.label || command.id;
}

function reasonText(code: string): string {
  return t(reasonKeys[code as keyof typeof reasonKeys] ?? reasonKeys.role_invalid);
}

/**
 * Проверяет карточку на том же снимке, что использует команда вставки.
 * Защита дубликатов остаётся в домене и повторяется при применении.
 */
function roleReason(role: StageRoleTemplate): string {
  if (!props.capabilities) {
    return 'role_invalid';
  }
  if (role.id === 'review' && !props.capabilities.commands.length) {
    return 'recheck_unavailable';
  }

  const preparedRole = prepareStageRole(plain(role), role.defaults, props.capabilities);
  const options = listStageInsertionPlaces(props.document, props.scope, preparedRole, props.capabilities);

  return options.some((place) => !place.disabledReason) ? ''
    : options.find((place) => place.disabledReason === 'role_duplicate')?.disabledReason
      || 'success_required';
}

/**
 * Новый выбор сбрасывает только намерение и подбирает раннего автора.
 * Ни документ, ни история до кнопки применения не меняются.
 */
function chooseRole(role: StageRoleTemplate): void {
  selectedRoleId.value = role.id;
  answers.value = normalizeStageRoleAnswers(role, {}, props.capabilities!);
  error.value = '';
  normalizeTarget();
}

/**
 * После выбора места сохраняет только допустимого раннего адресата возврата.
 * Пишущий агент ближе всего к месту вставки служит ответом по умолчанию.
 */
function normalizeTarget(): void {
  const targets = returnTargets.value;

  if (!targets.some((node) => node.id === answers.value.returnTargetId)) {
    const reversed = [...targets].reverse();
    const target = reversed.find((node) => node.executor === 'agent'
      && node.policy?.filesystem === 'workspace-write')
      ?? reversed.find((node) => node.executor === 'agent') ?? reversed[0];

    answers.value.returnTargetId = target?.id;
  }
  if (answers.value.failure === 'return' && !targets.length) {
    answers.value.failure = 'ask';
  }
}

/**
 * Переходит между вопросами и местом без сохранения в черновик.
 * Недоступное исходное место заменяется первым допустимым.
 */
function next(): void {
  if (!canContinue.value) {
    return;
  }

  step.value += 1;

  if (step.value === 3 && !places.value.some((place) =>
    place.afterId === afterId.value && !place.disabledReason)) {
    afterId.value = places.value.find((place) => !place.disabledReason)?.afterId ?? '';
  }
}

/**
 * Схема и список разделяют допустимые места вставки.
 * Клик по запретному месту показывает объяснение и сохраняет прежний выбор.
 */
function choosePlace(nodeId: string): void {
  const place = places.value.find((item) => item.afterId === nodeId);

  error.value = place?.disabledReason ? reasonText(place.disabledReason) : '';

  if (place && !place.disabledReason) {
    afterId.value = nodeId;
  }
}

/**
 * Пересчитывает пакет на актуальном документе перед единственным change.
 * Финал остаётся в телепортированном диалоге после выбора узла на телефоне.
 */
function apply(): void {
  if (!isCurrent() || !prepared.value || !props.capabilities) {
    return;
  }

  const result = insertStageRole(plain(props.document), props.scope, afterId.value,
    prepared.value, props.capabilities);

  if (!result.createdNodeIds[0]) {
    error.value = reasonText(result.issues[0]?.code ?? 'role_invalid');

    return;
  }

  insertedId.value = result.createdNodeIds[0];
  step.value = 4;
  emit('change', result.draft, insertedId.value);
}

/**
 * Проба использует штатный renderer только после успешной записи.
 * Смена адресата во время ожидания прерывает действие.
 */
async function previewPrompt(context: Record<string, unknown>): Promise<void> {
  if (busy.value || props.scope.kind !== 'route') {
    return;
  }

  busy.value = true;

  try {
    if (await saveStageWizardSnapshot(isCurrent)) {
      await previewRoutePrompt({
        scope: 'route',
        routeId: props.scope.routeId,
        nodeId: insertedId.value,
        context,
      });
    } else {
      error.value = t('core.stageWizardSaveError');
    }
  } finally {
    busy.value = false;
  }
}

/**
 * Запуск сценария разделяет с preview барьер сохранения.
 * Сам проход остаётся чистой штатной симуляцией движка.
 */
async function startSimulation(scope: 'route' | 'bootstrap', routeId: string | null,
  pinned: boolean, rounds: number | null): Promise<void> {
  if (busy.value) {
    return;
  }

  busy.value = true;

  try {
    if (await saveStageWizardSnapshot(isCurrent)) {
      startRouteSimulation(scope, routeId, pinned, rounds);
    } else {
      error.value = t('core.stageWizardSaveError');
    }
  } finally {
    busy.value = false;
  }
}

/**
 * Очищает намерение для следующего этапа, сохраняя уже применённый пакет.
 * Новый выбор вновь начнётся с карточек и создаст отдельный шаг истории.
 */
function addMore(): void {
  step.value = 1;
  selectedRoleId.value = null;
  answers.value = {};
  error.value = '';
}

/**
 * Двойной клик не создаёт вторую цепочку проверки и сравнения.
 * Успех закрывает мастер перед обычным подтверждением публикации.
 */
async function finish(): Promise<void> {
  if (busy.value) {
    return;
  }

  busy.value = true;
  error.value = '';

  try {
    if (await prepareStageWizardPublication(isCurrent)) {
      emit('close');
    } else {
      error.value = t('core.stageWizardCheckError');
    }
  } finally {
    busy.value = false;
  }
}

watch(address, () => emit('close'));
watch(afterId, normalizeTarget);
watch(() => answers.value.commandId, () => {
  if (selectedRole.value && props.capabilities) {
    answers.value = normalizeStageRoleAnswers(selectedRole.value, answers.value, props.capabilities);
  }
});
watch(() => answers.value.browser, (allowed) => {
  if (allowed) {
    answers.value.services = true;
  }
});
watch(() => answers.value.filesystem, (policy) => {
  if (policy !== 'workspace-write' && answers.value.failure === 'self-fix') {
    answers.value.failure = 'ask';
  }
});

onMounted(async () => {
  try {
    const result = await runtimeOf(store).api.stageRoles(store.opened!.profile);

    if (isCurrent()) {
      catalog.value = result;
    }
  } catch {
    if (isCurrent()) {
      catalogFailed.value = true;
    }
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.stage-wizard {
  display: grid;
  gap: 12px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.stage-wizard > *, .stage-wizard label {
  min-width: 0;
}

.stage-wizard label {
  display: grid;
  gap: 6px;
}

.stage-wizard__roles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr));
  gap: 12px;
}

.stage-wizard__roles small {
  display: block;
}

.stage-wizard__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.stage-wizard :deep(pre) {
  max-width: 100%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
