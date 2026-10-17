<template>
  <section class="route-node-inspector">
    <strong>{{ node?.label || node?.id || 'Этап не найден' }}</strong>
    <div v-if="node" class="route-node-identity">
      <label>ID этапа
        <UiInput data-test="node-new-id" :model-value="pendingId"
                 @update:model-value="pendingId = String($event ?? '')" />
      </label>
      <UiButton data-test="node-rename" :disabled="pendingId === node.id"
                @click="renameIdentity">Переименовать ID</UiButton>
      <label>Подпись
        <UiInput data-test="node-label" :model-value="pendingLabel"
                 @update:model-value="pendingLabel = String($event ?? '')" />
      </label>
      <UiButton data-test="node-save-label" @click="saveLabel">Сохранить подпись</UiButton>
      <label>Описание
        <UiInput data-test="node-description" :model-value="pendingDescription"
                 @update:model-value="pendingDescription = String($event ?? '')" />
      </label>
      <UiButton data-test="node-save-description" @click="saveDescription">
        Сохранить описание
      </UiButton>
      <label>Ключ запуска
        <UiInput data-test="node-run-key" :model-value="pendingRunKey"
                 @update:model-value="pendingRunKey = String($event ?? '')" />
      </label>
      <UiButton data-test="node-save-run-key" @click="saveRunKey">Сохранить ключ</UiButton>
      <div v-if="node.emits?.length" class="route-node-identity__emits">
        <span>Публикуемые статусы</span>
        <div v-for="statusId in node.emits" :key="statusId">
          {{ statusId }}
          <UiButton :data-test="`node-remove-emit-${statusId}`"
                    @click="removeEmit(statusId)">Убрать ссылку</UiButton>
        </div>
      </div>
      <p v-for="(issue, index) in identityIssues" :key="index" class="bad">{{ issue.message }}</p>
    </div>
    <label v-if="node">Тип этапа
      <UiSelect data-test="executor-type" :model-value="pendingType ?? node.executor"
                @update:model-value="chooseType(String($event ?? ''))">
        <option value="agent">Агент</option>
        <option value="command">Команда</option>
        <option value="gate">Ворота</option>
        <option value="status">Статус</option>
      </UiSelect>
    </label>
    <div v-if="pendingType && pendingType !== node?.executor" data-test="type-change-preview">
      <strong>Перед сменой типа</strong>
      <p v-for="(issue, index) in typeChangeIssues" :key="index">{{ issue.message }}</p>
      <UiButton data-test="cancel-type-change" @click="pendingType = null">Отмена</UiButton>
      <UiButton data-test="apply-type-change" :disabled="!typeChangeAllowed"
                @click="applyTypeChange">Применить</UiButton>
    </div>
    <template v-if="node?.executor === 'gate'">
      <p>Исходы: approved, rejected</p>
      <p>Публикует статусы: {{ node.emits?.join(', ') || 'нет' }}</p>
    </template>
    <template v-if="node?.executor === 'status'">
      <label>Ключ статуса
        <UiInput data-test="status-key" :model-value="node.key ?? ''"
                 @update:model-value="updateStatusKey(String($event ?? ''))" />
      </label>
      <label>Владелец
        <UiSelect data-test="status-owner" :model-value="node.owner ?? ''"
                  @update:model-value="updateStatusOwner(String($event ?? ''))">
          <option v-if="node.owner && !statusOwnerKnown"
                  :value="node.owner">{{ node.owner }} (недоступен)</option>
          <option v-for="owner in owners" :key="owner.id" :value="owner.id">
            {{ owner.label || owner.id }}
          </option>
        </UiSelect>
      </label>
    </template>
    <label v-if="node?.executor === 'command'">Команда проекта
      <UiSelect data-test="command-id" :model-value="node.commandId ?? ''"
                @update:model-value="updateCommand(String($event ?? ''))">
        <option value="">Выберите команду</option>
        <option v-if="node.commandId && !commandKnown" :value="node.commandId">
          {{ node.commandId }} (недоступна)
        </option>
        <option v-for="command in capabilities?.commands ?? []" :key="command.id"
                :value="command.id">{{ command.label }}</option>
      </UiSelect>
      <small v-if="node.commandId && !commandKnown" class="bad">
        Команда недоступна в профиле. Публикация заблокирована проверкой.
      </small>
    </label>
    <template v-if="node && (node.executor === 'agent' || node.executor === 'command')">
      <RoutePolicyFields v-if="node.policy && node.fanout" :policy="node.policy"
                         :fanout="node.fanout" :capabilities="capabilities"
                         @update:policy="updateNode('policy', $event)"
                         @update:fanout="updateNode('fanout', $event)" />
      <RouteRetryFields v-if="node.retry" :retry="node.retry" :capabilities="capabilities"
                        @update:retry="updateNode('retry', $event)" />
    </template>
    <aside v-if="node && node.executor !== 'status'" class="route-effective-policy">
      <strong>Эффективная политика запуска — только просмотр</strong>
      <p v-if="policyLoading" class="muted">Читаю политику запуска…</p>
      <p v-else-if="!effectivePolicy" class="muted">Политика запуска недоступна.</p>
      <template v-else>
        <p>Основной исполнитель: {{ effectivePolicy.primary || 'не указан' }}</p>
        <p>Резервные: {{ effectivePolicy.failover.join(', ') || 'не указаны' }}</p>
        <p>Источник: {{ effectivePolicy.source }}</p>
        <div v-for="(model, provider) in effectivePolicy.models" :key="provider">
          {{ provider }}: {{ model?.exact || model?.family || 'модель недоступна' }}
          · effort {{ model?.effort || 'недоступен' }}
        </div>
      </template>
    </aside>
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type {
  DraftNode,
  RouteFanout,
  RoutePolicy,
  RouteRetry,
} from '../../../../shared/pipeline/routeDefinition.ts';
import type {
  RouteDraft, RouteEditorInfo, RouteEffectivePolicy,
} from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { NewExecutor, RouteCommandIssue, RouteCommandResult,
  RouteCommandScope } from './routeCommands.ts';
import { changeNodeExecutor, renameNode, setNodeLabel, setNodeDescription,
  setNodeRunKey, removeEmitReference } from './routeCommands.ts';
import { UiButton, UiInput, UiSelect } from '../../ui';
import { routesApi } from '../../shared/routesApi.ts';
import RoutePolicyFields from './RoutePolicyFields.vue';
import RouteRetryFields from './RouteRetryFields.vue';

const props = defineProps<{
  document: RouteDraft;
  scope: RouteCommandScope;
  nodeId: string;
  capabilities: RouteEditorInfo['capabilities'] | null;
}>();
const emit = defineEmits<{ change: [document: RouteDraft];
  'select-node': [value: { scope: RouteCommandScope; nodeId: string }] }>();
const pendingType = ref<NewExecutor | null>(null);
const pendingId = ref('');
const pendingLabel = ref('');
const pendingDescription = ref('');
const pendingRunKey = ref('');
const identityIssues = ref<RouteCommandIssue[]>([]);
const effectivePolicy = ref<RouteEffectivePolicy | null>(null);
const policyLoading = ref(false);
let policyRequest = 0;
const node = computed(() => props.scope.kind === 'bootstrap'
  ? props.document.bootstrap.nodes.find((item) => item.id === props.nodeId)
  : props.document.routes[props.scope.routeId]?.route.nodes.find((item) => item.id === props.nodeId));
const owners = computed(() => {
  const machine = props.scope.kind === 'bootstrap'
    ? props.document.bootstrap : props.document.routes[props.scope.routeId]?.route;

  return machine?.nodes.filter((item) => item.executor !== 'status') ?? [];
});
const statusOwnerKnown = computed(() => owners.value.some((owner) =>
  owner.id === node.value?.owner));
const commandKnown = computed(() => Boolean(props.capabilities?.commands.some((command) =>
  command.id === node.value?.commandId)));
const typeChangeIssues = computed(() => {
  if (!pendingType.value || !node.value) {
    return [];
  }

  const plain = JSON.parse(JSON.stringify(props.document)) as RouteDraft;

  return changeNodeExecutor(plain, props.scope, props.nodeId, pendingType.value, false).issues;
});
const typeChangeAllowed = computed(() => !typeChangeIssues.value.some((issue) =>
  issue.code === 'executor_change_unavailable' || issue.code === 'owner_required'));

watch(() => [props.scope.kind, props.scope.kind === 'route' ? props.scope.routeId : '',
  props.nodeId], () => {
  pendingId.value = node.value?.id ?? '';
  pendingLabel.value = node.value?.label ?? '';
  pendingDescription.value = node.value?.description ?? '';
  pendingRunKey.value = node.value?.runKey ?? node.value?.key ?? '';
  identityIssues.value = [];
}, { immediate: true });

/**
 * Передаёт результат изменения идентичности узла и его проблемы.
 * Инспектор применяет правку к копии полного черновика.
 */
function applyIdentity(result: RouteCommandResult, input: RouteDraft): boolean {
  identityIssues.value = result.issues;

  if (result.draft === input) {
    return false;
  }

  emit('change', result.draft);

  return true;
}

function renameIdentity(): void {
  const input = JSON.parse(JSON.stringify(props.document)) as RouteDraft;

  if (applyIdentity(renameNode(input, props.scope, props.nodeId, pendingId.value.trim()), input)) {
    emit('select-node', { scope: props.scope, nodeId: pendingId.value.trim() });
  }
}

function saveLabel(): void {
  const input = JSON.parse(JSON.stringify(props.document)) as RouteDraft;

  applyIdentity(setNodeLabel(input, props.scope, props.nodeId, pendingLabel.value), input);
}

function saveDescription(): void {
  const input = JSON.parse(JSON.stringify(props.document)) as RouteDraft;

  applyIdentity(setNodeDescription(input, props.scope, props.nodeId,
    pendingDescription.value), input);
}

function saveRunKey(): void {
  const input = JSON.parse(JSON.stringify(props.document)) as RouteDraft;

  applyIdentity(setNodeRunKey(input, props.scope, props.nodeId, pendingRunKey.value.trim()), input);
}

function removeEmit(statusId: string): void {
  const input = JSON.parse(JSON.stringify(props.document)) as RouteDraft;

  applyIdentity(removeEmitReference(input, props.scope, props.nodeId, statusId), input);
}

watch(() => [props.document.profile, node.value?.runKey], async ([profile, runKey]) => {
  const request = ++policyRequest;

  effectivePolicy.value = null;
  policyLoading.value = Boolean(profile && runKey);

  if (!profile || !runKey) {
    return;
  }

  try {
    const value = await routesApi.effectivePolicy(profile, runKey);

    if (request === policyRequest && value?.runKey === runKey) {
      effectivePolicy.value = value;
    }
  } catch {
    // Недоступность reader не делает черновик и его форму недоступными.
  } finally {
    if (request === policyRequest) {
      policyLoading.value = false;
    }
  }
}, { immediate: true });
onUnmounted(() => {
   policyRequest += 1;
});

/**
 * Выбирает новый тип исполнителя для последующего подтверждения.
 * Инспектор применяет правку к копии полного черновика.
 */
function chooseType(value: string): void {
  if (!['agent', 'command', 'gate', 'status'].includes(value)) {
    return;
  }

  pendingType.value = value === node.value?.executor ? null : value as NewExecutor;
}

/**
 * Меняет исполнителя после проверки потери несовместимых полей.
 * Инспектор применяет правку к копии полного черновика.
 */
function applyTypeChange(): void {
  if (!pendingType.value || !typeChangeAllowed.value) {
    return;
  }

  const plain = JSON.parse(JSON.stringify(props.document)) as RouteDraft;
  const result = changeNodeExecutor(plain, props.scope, props.nodeId, pendingType.value, true);

  if (result.draft !== plain) {
    emit('change', result.draft);
  }

  pendingType.value = null;
}

/**
 * Изменяет политику, fanout или повтор выбранного узла.
 * Инспектор применяет правку к копии полного черновика.
 */
function updateNode(key: 'policy' | 'fanout' | 'retry', value: DraftNode[typeof key]): void {
  const copy = JSON.parse(JSON.stringify(props.document)) as RouteDraft;
  const machine = props.scope.kind === 'bootstrap'
    ? copy.bootstrap : copy.routes[props.scope.routeId]?.route;
  const target = machine?.nodes.find((item) => item.id === props.nodeId);

  if (!target) {
    return;
  }
  if (key === 'policy') {
    target.policy = value as RoutePolicy;
  }
  else if (key === 'fanout') {
    target.fanout = value as RouteFanout;
  }
  else {
    target.retry = value as RouteRetry;
  }

  emit('change', copy);
}

/**
 * Выбирает только команду, объявленную возможностями профиля.
 * Инспектор применяет правку к копии полного черновика.
 */
function updateCommand(commandId: string): void {
  if (commandId && !props.capabilities?.commands.some((command) => command.id === commandId)) {
    return;
  }

  const copy = JSON.parse(JSON.stringify(props.document)) as RouteDraft;
  const machine = props.scope.kind === 'bootstrap'
    ? copy.bootstrap : copy.routes[props.scope.routeId]?.route;
  const target = machine?.nodes.find((item) => item.id === props.nodeId);

  if (!target || target.executor !== 'command') {
    return;
  }

  target.commandId = commandId;
  emit('change', copy);
}

/**
 * Меняет статус, который публикует выбранный узел.
 * Инспектор применяет правку к копии полного черновика.
 */
function updateStatusKey(key: string): void {
  const copy = JSON.parse(JSON.stringify(props.document)) as RouteDraft;
  const machine = props.scope.kind === 'bootstrap'
    ? copy.bootstrap : copy.routes[props.scope.routeId]?.route;
  const status = machine?.nodes.find((item) => item.id === props.nodeId);

  if (!status || status.executor !== 'status') {
    return;
  }

  status.key = key;
  emit('change', copy);
}

/**
 * Назначает владельца результата status.
 * Инспектор применяет правку к копии полного черновика.
 */
function updateStatusOwner(ownerId: string): void {
  const copy = JSON.parse(JSON.stringify(props.document)) as RouteDraft;
  const machine = props.scope.kind === 'bootstrap'
    ? copy.bootstrap : copy.routes[props.scope.routeId]?.route;
  const status = machine?.nodes.find((item) => item.id === props.nodeId);
  const owner = machine?.nodes.find((item) => item.id === ownerId && item.executor !== 'status');

  if (!status || status.executor !== 'status' || !owner) {
    return;
  }

  const previous = machine?.nodes.find((item) => item.id === status.owner);

  if (previous) {
    previous.emits = (previous.emits ?? []).filter((id) => id !== status.id);
  }

  owner.emits = [...new Set([...(owner.emits ?? []), status.id])];
  status.owner = owner.id;
  status.phase = owner.phase;
  emit('change', copy);
}
</script>

<style scoped>
.route-node-identity { display: grid; gap: 6px; margin: 10px 0; }
.route-node-identity label { display: grid; gap: 3px; }
.route-node-identity__emits { display: grid; gap: 4px; }
.route-effective-policy { border: 1px solid var(--line); border-radius: 8px;
  padding: 8px; margin-top: 10px; }
.route-effective-policy p { margin: 4px 0; }
</style>
