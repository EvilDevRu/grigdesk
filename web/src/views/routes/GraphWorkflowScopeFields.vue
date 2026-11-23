<template>
  <div class="gw-scope">
    <article v-for="step in scope.steps" :key="step.id" class="gw-step" :data-workflow-step="step.id">
      <header class="gw-step__head">
        <UiInput
          :model-value="step.title"
          :aria-label="t('core.workflowTitle')"
          @update:model-value="patch(step.id, { title: String($event ?? '') })"
        />
        <UiSelect
          :model-value="step.kind"
          :aria-label="t('core.workflowStepLabel')"
          @update:model-value="changeKind(step, String($event ?? 'input'))"
        >
          <option v-for="kind in kinds" :key="kind" :value="kind">{{ t(kindKey(kind)) }}</option>
        </UiSelect>
        <span data-workflow-return>
          <UiCheckbox
            :model-value="scope.returns.includes(step.id)"
            :label="t('core.workflowReturns')"
            @update:model-value="toggleReturn(step.id, Boolean($event))"
          />
        </span>
        <UiButton variant="ghost" data-workflow-delete @click="remove(step.id)">{{ t('core.workflowDeleteStep') }}</UiButton>
      </header>

      <fieldset class="gw-step__edges">
        <legend>{{ t('core.workflowNeeds') }}</legend>
        <span v-for="other in scope.steps.filter((item) => item.id !== step.id)" :key="other.id" :data-workflow-edge="other.id">
          <UiCheckbox
            :model-value="(step.needs ?? []).includes(other.id)"
            :label="other.title || other.id"
            @update:model-value="toggleEdge(step, other.id, Boolean($event))"
          />
        </span>
      </fieldset>

      <fieldset v-if="step.kind !== 'join'" class="gw-step__reads">
        <legend>{{ t('core.workflowReads') }}</legend>
        <span v-for="source in readOptions(step)" :key="source" :data-workflow-read="source">
          <UiCheckbox
            :model-value="(step.reads ?? defaultReads(step)).includes(source)"
            :label="source"
            @update:model-value="toggleRead(step, source, Boolean($event))"
          />
        </span>
      </fieldset>

      <div v-if="step.kind !== 'join'" class="gw-step__when">
        <span data-workflow-condition-source>
          <UiSelect
            :model-value="step.when?.source ?? ''"
            :aria-label="t('core.workflowWhen')"
            @update:model-value="setWhenSource(step, String($event ?? ''))"
          >
            <option value="">—</option>
            <option v-for="need in step.needs ?? []" :key="need" :value="need">{{ need }}</option>
          </UiSelect>
        </span>
        <span v-if="step.when" data-workflow-condition-test>
          <UiSelect
            :model-value="step.when.test"
            :aria-label="t('core.workflowWhen')"
            @update:model-value="patch(step.id, { when: { ...step.when!, test: $event === 'empty' ? 'empty' : 'nonempty' } })"
          >
            <option value="nonempty">{{ t('core.workflowWhenNonempty') }}</option>
            <option value="empty">{{ t('core.workflowWhenEmpty') }}</option>
          </UiSelect>
        </span>
      </div>

      <span v-if="step.kind === 'agent'" data-workflow-prompt>
        <UiTextarea
          :model-value="step.prompt ?? ''"
          :placeholder="t('core.workflowPrompt')"
          @update:model-value="patch(step.id, { prompt: String($event ?? '') })"
        />
      </span>

      <span v-if="step.kind === 'forEach'" data-workflow-from>
        <UiSelect
          :model-value="step.source ?? ''"
          :aria-label="t('core.workflowSource')"
          @update:model-value="patch(step.id, { source: String($event ?? '') })"
        >
          <option v-for="need in step.needs ?? []" :key="need" :value="need">{{ need }}</option>
        </UiSelect>
      </span>

      <div v-if="step.kind === 'forEach'" class="gw-step__join" data-workflow-parallelism>
        <span>{{ t('core.workflowParallelism') }}</span>
        <UiSelect
          :model-value="step.parallelism ? 'limited' : 'all'"
          :aria-label="t('core.workflowParallelism')"
          @update:model-value="patch(step.id, { parallelism: $event === 'limited' ? 1 : undefined })"
        >
          <option value="all">{{ t('core.workflowParallelismAll') }}</option>
          <option value="limited">{{ t('core.workflowParallelismLimited') }}</option>
        </UiSelect>
        <UiNumberInput
          v-if="step.parallelism"
          min="1"
          :max="WORKFLOW_MAX_BRANCH_PARALLELISM"
          :model-value="step.parallelism"
          :aria-label="t('core.workflowParallelismCount')"
          @update:model-value="setParallelism(step, $event)"
        />
      </div>

      <span v-if="step.kind === 'repeat'" data-workflow-rounds>
        <UiInput
          min="1"
          max="5"
          :model-value="String(step.maxRounds ?? 2)"
          :aria-label="t('core.workflowRounds')"
          @update:model-value="patch(step.id, { maxRounds: clampRounds($event) })"
        />
      </span>

      <div v-if="step.kind === 'join' || step.kind === 'forEach'" class="gw-step__join" data-workflow-join-mode>
        <UiSelect
          :model-value="step.mode ?? 'all'"
          :aria-label="t('core.workflowKindJoin')"
          @update:model-value="setMode(step, String($event ?? 'all'))"
        >
          <option value="all">{{ t('core.workflowJoinAll') }}</option>
          <option value="any">{{ t('core.workflowJoinAny') }}</option>
          <option value="quorum">{{ t('core.workflowJoinQuorum') }}</option>
        </UiSelect>
        <span v-if="step.mode === 'quorum'" data-workflow-min-success>
          <UiInput
            min="1"
            :model-value="String(step.minSuccess ?? 1)"
            :aria-label="t('core.workflowMinSuccess')"
            @update:model-value="patch(step.id, { minSuccess: Math.max(1, Number($event) || 1) })"
          />
        </span>
      </div>

      <fieldset v-if="step.kind === 'approval'" class="gw-step__retry">
        <legend>{{ t('core.workflowRetryFrom') }}</legend>
        <span v-for="ancestor in ancestors(step)" :key="ancestor" :data-workflow-retry-from="ancestor">
          <UiCheckbox
            :model-value="(step.retryFrom ?? []).includes(ancestor)"
            :label="ancestor"
            @update:model-value="toggleRetryFrom(step, ancestor, Boolean($event))"
          />
        </span>
      </fieldset>

      <div v-if="hasScope(step.kind)" class="gw-step__scope">
        <UiButton v-if="!step.scope" variant="ghost" data-workflow-add-scope @click="patch(step.id, { scope: { steps: [], returns: [] } })">
          {{ t('core.workflowAddScope') }}
        </UiButton>
        <GraphWorkflowScopeFields
          v-if="step.scope"
          :scope="step.scope"
          :depth="(depth ?? 0) + 1"
          @update:scope="patch(step.id, { scope: $event })"
          :subflow-scope="subflowScope"
        />
      </div>
    </article>
    <div class="gw-scope__tools">
      <UiButton variant="ghost" data-workflow-add @click="addStep">{{ t('core.workflowAddStep') }}</UiButton>
      <UiButton variant="ghost" data-workflow-insert-subflow @click="insertSubflow">{{ t('core.workflowInsertSubflow') }}</UiButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRaw } from 'vue';

import { t, UiButton, UiCheckbox, UiInput, UiNumberInput, UiSelect, UiTextarea } from '../../ui';
import type { MessageKey } from '../../../../shared/i18n/catalogs.ts';
import {
  WORKFLOW_MAX_BRANCH_PARALLELISM,
  type WorkflowScope, type WorkflowStep, type WorkflowStepKind,
} from '../../../../shared/pipeline/graphWorkflowContracts.ts';
import {
  removeWorkflowStep, toggleWorkflowEdge, updateWorkflowStep,
} from '../../shared/graphWorkflowDraft.ts';

const props = defineProps<{
  scope: WorkflowScope;
  depth?: number;
  subflowScope?: WorkflowScope | null;
}>();

const emit = defineEmits<{
  'update:scope': [scope: WorkflowScope];
}>();

const kinds: WorkflowStepKind[] = [
  'input', 'sections', 'agent', 'meetingTasks', 'forEach', 'call', 'repeat', 'join', 'approval',
];

const kindKeys = {
  input: 'core.workflowKindInput',
  sections: 'core.workflowKindSections',
  agent: 'core.workflowKindAgent',
  meetingTasks: 'core.workflowKindMeetingTasks',
  forEach: 'core.workflowKindForEach',
  call: 'core.workflowKindCall',
  repeat: 'core.workflowKindRepeat',
  join: 'core.workflowKindJoin',
  approval: 'core.workflowKindApproval',
} as const;

/**
 * Подпись вида шага берётся из закрытой таблицы переводов.
 * Введённый пользователем текст не используется как ключ.
 */
function kindKey(kind: WorkflowStepKind): MessageKey {
  return kindKeys[kind];
}

function hasScope(kind: string): boolean {
  return kind === 'forEach' || kind === 'call' || kind === 'repeat';
}

function patch(id: string, value: Partial<Omit<WorkflowStep, 'id'>>): void {
  emit('update:scope', updateWorkflowStep(toRaw(props.scope), id, value));
}

/**
 * Шаг области получает первый свободный целый ID step-N.
 * Нумерация локальна для области и не пересекается с соседними.
 */
function addStep(): void {
  let index = 1;

  while (toRaw(props.scope).steps.some((step) => step.id === 'step-' + index)) {
    index += 1;
  }

  const scope = toRaw(props.scope);

  emit('update:scope', {
    ...scope,
    steps: [...scope.steps, {
      id: 'step-' + index,
      title: t('core.workflowStepLabel') + ' ' + index,
      kind: 'input',
    }],
  });
}

/**
 * Новый подмаршрут добавляется в текущую область по локальному ID.
 * Дочерний редактор возвращает весь список своих шагов родителю.
 */
function insertSubflow(): void {
  const scope = toRaw(props.scope);
  let index = 1;

  while (scope.steps.some((step) => step.id === 'sub-' + index)) {
    index += 1;
  }

  emit('update:scope', {
    ...scope,
    steps: [...scope.steps, {
      id: 'sub-' + index,
      title: t('core.workflowKindCall'),
      kind: 'call',
      scope: props.subflowScope ? JSON.parse(JSON.stringify(props.subflowScope)) : { steps: [], returns: [] },
    }],
  });
}

/**
 * Смена вида сохраняет id/title/needs/reads и пересоздаёт остальные поля.
 * Так запрещённые для нового вида поля не переживают переключение.
 */
function changeKind(step: WorkflowStep, kind: string): void {
  const raw = toRaw(step);
  const next: WorkflowStep = {
    id: raw.id,
    title: raw.title,
    kind: kind as WorkflowStepKind,
    needs: raw.needs,
    reads: kind === 'join' ? undefined : raw.reads,
    when: kind === 'join' ? undefined : raw.when,
  };

  if (kind === 'agent') {
    next.prompt = '';
  }
  if (hasScope(kind)) {
    next.scope = raw.scope ?? { steps: [], returns: [] };
  }
  if (kind === 'forEach') {
    next.source = raw.needs?.[0] ?? '';
    next.mode = 'all';
  }
  if (kind === 'repeat') {
    next.maxRounds = 2;
  }
  if (kind === 'join') {
    next.mode = 'all';
  }

  emit('update:scope', {
    ...props.scope,
    steps: props.scope.steps.map((item) => item.id === step.id ? next : item),
  });
}

function toggleEdge(step: WorkflowStep, source: string, enabled: boolean): void {
  emit('update:scope', toggleWorkflowEdge(toRaw(props.scope), toRaw(step), source, enabled));
}

function defaultReads(step: WorkflowStep): string[] {
  return step.kind === 'input' ? ['$inputs'] : (step.needs ?? []);
}

/**
 * Чтение предлагает зависимости шага и общий вход $inputs.
 * Внутри подмаршрута добавляется элемент цикла $item.
 */
function readOptions(step: WorkflowStep): string[] {
  const options = [...(step.needs ?? [])];

  options.push('$inputs');

  if ((props.depth ?? 0) > 0) {
    options.push('$item');
  }

  return options;
}

/**
 * Явный выбор чтения замещает дефолт; пустой список означает отсутствие данных.
 * Удалённая зависимость исчезает из чтения вместе с ребром.
 */
function toggleRead(step: WorkflowStep, source: string, enabled: boolean): void {
  const current = step.reads ?? defaultReads(step);
  const next = new Set(current);

  if (enabled) {
    next.add(source);
  } else {
    next.delete(source);
  }

  patch(step.id, { reads: [...next] });
}

function setWhenSource(step: WorkflowStep, source: string): void {
  if (!source) {
    patch(step.id, { when: undefined });

    return;
  }

  patch(step.id, { when: { source, test: step.when?.test ?? 'nonempty' } });
}

/**
 * В ограниченном режиме сохраняется целое число элементов.
 * Предел редактора совпадает с максимальным числом экземпляров движка.
 */
function setParallelism(step: WorkflowStep, value: unknown): void {
  const count = Math.trunc(Number(value)) || 1;

  patch(step.id, { parallelism: Math.min(WORKFLOW_MAX_BRANCH_PARALLELISM, Math.max(1, count)) });
}

function setMode(step: WorkflowStep, mode: string): void {
  if (mode === 'quorum') {
    patch(step.id, { mode: 'quorum', minSuccess: step.minSuccess ?? 1 });

    return;
  }

  patch(step.id, { mode: mode as 'all' | 'any', minSuccess: undefined });
}

function clampRounds(value: unknown): number {
  return Math.min(5, Math.max(1, Number(value) || 2));
}

/**
 * Цели возврата — транзитивные предки шага в текущей области.
 * Список строится по needs, чужие области недоступны.
 */
function ancestors(step: WorkflowStep): string[] {
  const seen = new Set<string>();
  const queue = [...(step.needs ?? [])];

  while (queue.length) {
    const id = queue.shift()!;

    if (seen.has(id)) {
      continue;
    }

    seen.add(id);

    const parent = props.scope.steps.find((item) => item.id === id);

    queue.push(...(parent?.needs ?? []));
  }

  return [...seen];
}

function toggleRetryFrom(step: WorkflowStep, target: string, enabled: boolean): void {
  const next = new Set(step.retryFrom ?? []);

  if (enabled) {
    next.add(target);
  } else {
    next.delete(target);
  }

  patch(step.id, { retryFrom: [...next] });
}

function toggleReturn(id: string, enabled: boolean): void {
  const returns = new Set(props.scope.returns);

  if (enabled) {
    returns.add(id);
  } else {
    returns.delete(id);
  }

  emit('update:scope', { ...toRaw(props.scope), returns: [...returns] });
}

function remove(id: string): void {
  emit('update:scope', removeWorkflowStep(toRaw(props.scope), id));
}
</script>

<style scoped>
.gw-scope {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gw-step {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--ui-border, #d0d7de);
  border-radius: 8px;
}

.gw-step__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.gw-step__edges,
.gw-step__reads,
.gw-step__retry {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  border: none;
  padding: 0;
}

.gw-step__when,
.gw-step__join {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.gw-step__scope {
  padding-left: 12px;
  border-left: 2px solid var(--ui-border, #d0d7de);
}

.gw-scope__tools {
  display: flex;
  gap: 8px;
}
</style>