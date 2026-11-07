<template>
  <section class="route-transition-inspector ui-workspace-section" aria-label="Что делать после этапа">
    <UiPaneHeader>
      <template #title><h3>Что делать после этапа</h3></template>
    </UiPaneHeader>
    <div class="ui-workspace-section__body">
      <p class="route-transition-help">
        Для каждого результата выберите действие и следующий этап.
        Изменения сохраняются автоматически в черновик.
      </p>
      <template v-if="node && node.executor !== 'status'">
        <UiButton data-context="workspace-form" v-if="(node.executor === 'agent' || node.executor === 'command') && !node.onFailure"
                  data-test="enable-failure-routes" @click="toggleFailureRoutes(true)">
          Настроить действия при ошибках
        </UiButton>
        <UiButton data-context="workspace-form" v-if="node.onFailure" data-test="disable-failure-routes"
                  @click="toggleFailureRoutes(false)">Убрать отдельные действия при ошибках</UiButton>
        <fieldset v-for="group in groups" :key="group.name">
          <legend>{{ group.name === 'on' ? 'Результат этапа' : 'Причина ошибки' }}</legend>
          <div v-for="entry in group.entries" :key="entry.outcome" class="route-transition-row">
            <span>
              {{ outcomeNames[entry.outcome] ?? entry.outcome }}
              <small v-if="outcomeNames[entry.outcome]" class="muted">{{ entry.outcome }}</small>
            </span>
            <UiSelect :data-test="`action-${group.name}-${entry.outcome}`"
                      :aria-label="`Действие: ${outcomeNames[entry.outcome] ?? entry.outcome}`"
                      :model-value="actionOf(entry.transition)"
                      @update:model-value="changeAction(group.name, entry.outcome, String($event ?? ''))">
              <option value="incomplete">Не выбрано</option>
              <option value="next">Дальше</option>
              <option value="rewind">Возврат</option>
              <option value="stop">Остановить</option>
              <option value="escalate">Сменить маршрут</option>
            </UiSelect>
            <UiSelect v-if="actionOf(entry.transition) === 'next' || actionOf(entry.transition) === 'rewind'"
                      :data-test="`target-${group.name}-${entry.outcome}`"
                      :aria-label="`Следующий этап: ${outcomeNames[entry.outcome] ?? entry.outcome}`"
                      :model-value="entry.transition?.next ?? entry.transition?.rewind ?? ''"
                      @update:model-value="changeTarget(group.name, entry.outcome,
                        actionOf(entry.transition), String($event ?? ''))">
              <option value="">Выберите этап</option>
              <option v-for="target in targets" :key="target.id" :value="target.id">
                {{ target.label || target.id }}
              </option>
            </UiSelect>
            <UiSelect v-if="actionOf(entry.transition) === 'stop'"
                      :data-test="`stop-kind-${group.name}-${entry.outcome}`"
                      :aria-label="`Причина остановки: ${outcomeNames[entry.outcome] ?? entry.outcome}`"
                      :model-value="entry.transition?.stop ?? 'human'"
                      @update:model-value="changeStop(group.name, entry.outcome, String($event ?? ''))">
              <option value="human">Ждать человека</option>
              <option value="failed">Завершить с ошибкой</option>
              <option value="done">Завершить успешно</option>
            </UiSelect>
            <span v-if="actionOf(entry.transition) === 'rewind'" class="muted">
              Сброс: {{ entry.transition?.reset?.join(', ') || 'после выбора цели' }}
            </span>
            <span v-if="actionOf(entry.transition) === 'escalate'" class="muted">
              Маршруты: {{ entry.transition?.escalate?.routes.join(', ') || 'не выбраны' }}
            </span>
            <div v-if="actionOf(entry.transition) === 'escalate'" class="route-transition-choices">
              <UiButton data-context="workspace-form" v-for="routeId in escalation?.allowedRoutes ?? []" :key="routeId"
                        :data-test="`escalate-route-${group.name}-${entry.outcome}-${routeId}`"
                        :aria-pressed="entry.transition?.escalate?.routes.includes(routeId) ?? false"
                        @click="toggleTransitionRoute(group.name, entry.outcome,
                          entry.transition, routeId)">{{ routeId }}</UiButton>
            </div>
          </div>
        </fieldset>
        <fieldset>
          <legend>Разрешённые маршруты для смены</legend>
          <UiButton data-context="workspace-form" v-for="routeId in routeIds" :key="routeId"
                    :data-test="`allow-route-${routeId}`"
                    :aria-pressed="escalation?.allowedRoutes.includes(routeId) ?? false"
                    @click="toggleAllowedRoute(routeId)">{{ routeId }}</UiButton>
          <label>Решение человека при закреплённом маршруте
            <UiSelect data-test="human-when-pinned"
                      :model-value="String(escalation?.requiresHumanWhenPinned ?? true)"
                      @update:model-value="changeHumanRule(String($event ?? ''))">
              <option value="true">Требуется</option>
              <option value="false">Не требуется</option>
            </UiSelect>
          </label>
        </fieldset>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RouteTransitionDoc } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteDraft } from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteCommandScope } from './routeCommands.ts';
import { setEscalation, setFailureRoutes, setTransition } from './routeCommands.ts';
import { UiButton, UiPaneHeader, UiSelect } from '../../ui';
import { outcomeNames } from './routeLabels.ts';

const props = defineProps<{
  document: RouteDraft;
  scope: RouteCommandScope;
  nodeId: string
}>();
const emit = defineEmits<{ change: [document: RouteDraft] }>();
const machine = computed(() => props.scope.kind === 'bootstrap'
  ? props.document.bootstrap : props.document.routes[props.scope.routeId]?.route);
const node = computed(() => props.scope.kind === 'bootstrap'
  ? props.document.bootstrap.nodes.find((item) => item.id === props.nodeId)
  : props.document.routes[props.scope.routeId]?.route.nodes.find((item) => item.id === props.nodeId));

type GroupName = 'on' | 'onFailure';

const groups = computed(() => (['on', 'onFailure'] as const).flatMap((name) => {
  const entries = node.value?.[name];

  if (!entries) {
    return [];
  }

  return [{ name, entries: Object.entries(entries).map(([outcome, transition]) =>
    ({ outcome, transition })) }];
}));
const targets = computed(() => machine.value?.nodes.filter((item) => item.executor !== 'status') ?? []);
const routeIds = computed(() => Object.keys(props.document.routes).sort());
const escalation = computed(() => machine.value?.escalation.find((record) =>
  record.from === props.nodeId) ?? null);

/**
 * Определяет действие, заданное существующим переходом.
 * Изменение применяется к выбранному исходу, сохраняя остальные переходы.
 */
function actionOf(transition: RouteTransitionDoc | null | undefined): string {
  if (!transition) {
    return 'incomplete';
  }
  if (transition.next !== undefined) {
    return 'next';
  }
  if (transition.rewind !== undefined) {
    return 'rewind';
  }
  if (transition.stop !== undefined) {
    return 'stop';
  }
  if (transition.escalate !== undefined) {
    return 'escalate';
  }

  return 'incomplete';
}

function apply(group: GroupName, outcome: string, transition: RouteTransitionDoc | null): void {
  const plain = JSON.parse(JSON.stringify(props.document)) as RouteDraft;
  const result = setTransition(plain, props.scope, props.nodeId, outcome, transition, group);

  if (result.draft !== plain) {
    emit('change', result.draft);
  }
}

function changeAction(group: GroupName, outcome: string, action: string): void {
  const choices: Record<string, RouteTransitionDoc | null> = {
    incomplete: null,
    next: { next: '' },
    rewind: { rewind: '', reset: [] },
    stop: { stop: 'human' },
    escalate: { escalate: { routes: [] } },
  };

  if (Object.hasOwn(choices, action)) {
    apply(group, outcome, choices[action] ?? null);
  }
}

/**
 * Записывает выбранную цель перехода либо действие stop/escalate.
 * Изменение применяется к выбранному исходу, сохраняя остальные переходы.
 */
function changeTarget(group: GroupName, outcome: string, action: string, target: string): void {
  if (action === 'next') {
    apply(group, outcome, { next: target });
  }
  else if (action === 'rewind') {
    apply(group, outcome, { rewind: target, reset: [] });
  }
}

function changeStop(group: GroupName, outcome: string, kind: string): void {
  apply(group, outcome, { stop: kind });
}

function toggleFailureRoutes(enabled: boolean): void {
  const plain = JSON.parse(JSON.stringify(props.document)) as RouteDraft;
  const result = setFailureRoutes(plain, props.scope, props.nodeId, enabled);

  if (result.draft !== plain) {
    emit('change', result.draft);
  }
}

function toggleAllowedRoute(routeId: string): void {
  const current = escalation.value?.allowedRoutes ?? [];
  const allowed = current.includes(routeId)
    ? current.filter((id) => id !== routeId) : [...current, routeId];

  changeEscalation(allowed, escalation.value?.requiresHumanWhenPinned ?? true);
}

function changeHumanRule(value: string): void {
  changeEscalation(escalation.value?.allowedRoutes ?? [], value === 'true');
}

function changeEscalation(allowedRoutes: string[], requiresHumanWhenPinned: boolean): void {
  const plain = JSON.parse(JSON.stringify(props.document)) as RouteDraft;
  const result = setEscalation(plain, props.scope, props.nodeId,
    allowedRoutes, requiresHumanWhenPinned);

  if (result.draft !== plain) {
    emit('change', result.draft);
  }
}

function toggleTransitionRoute(group: GroupName, outcome: string,
  transition: RouteTransitionDoc | null, routeId: string): void {
  const current = transition?.escalate?.routes ?? [];
  const routes = current.includes(routeId)
    ? current.filter((id) => id !== routeId) : [...current, routeId];

  apply(group, outcome, { escalate: { routes } });
}
</script>

<style scoped>
.route-transition-inspector fieldset {
  display: grid;
  gap: 8px;
  border: 1px solid var(--line);
  margin: 0;
}

.route-transition-inspector fieldset > label {
  display: grid;
  gap: 6px;
}

.route-transition-row {
  display: grid;
  grid-template-columns: minmax(60px, 0.6fr) repeat(2, minmax(0, 1fr));
  align-items: center;
  gap: 6px;
}

.route-transition-help {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}

.route-transition-row small {
  display: block;
}

.route-transition-inspector {
  min-width: 0;
  container: route-transitions / inline-size;
}

@container route-transitions (max-width: 340px) {

  .route-transition-row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .route-transition-row > span:first-child {
    grid-column: 1 / -1;
  }
}
</style>
