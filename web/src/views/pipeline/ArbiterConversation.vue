<template>
  <section class="ac ui-workspace" data-ui-workspace data-role="arbiter-conversation"
           :aria-label="t('core.arbiterDialogTitle')">
    <div class="ac-layout" :class="{ 'ac-layout--single': !showDecisions }">
      <div class="ac-thread">
        <header class="ac-heading">
          <span class="ac-avatar" data-author="arbiter" aria-hidden="true">⚖</span>
          <div class="ac-heading-copy">
            <h3>{{ t('core.arbiterSourceArbiter') }}</h3>
            <p class="ac-status" role="status" aria-live="polite">
              <UiSpinner v-if="analyzing" decorative />
              {{ status }}
            </p>
          </div>
          <span v-if="analyzing && arbitrating?.model" class="ac-model mono">{{ arbitrating.model }}</span>
        </header>
        <p v-if="doc?.automatic" class="ac-automatic">{{ t('core.arbiterAutomaticNotice') }}</p>
        <p v-if="error" class="ac-error" role="alert">{{ error }}</p>
        <div v-if="historyChoices.length" class="ac-history">
          <label :for="`${inputId}-history`">{{ t('core.arbiterHistory') }}</label>
          <UiSelect :id="`${inputId}-history`" :model-value="selectedHistory"
                    @update:model-value="selectHistory">
            <option value="">{{ t('core.arbiterCurrentStop') }}</option>
            <option v-for="(item, index) in historyChoices" :key="item.conversationId"
                    :value="item.conversationId">
              {{ t('core.arbiterEarlierAnalysis', { number: index + 1 }) }}
            </option>
          </UiSelect>
        </div>

        <section v-if="sourceMessages.length" class="ac-source" :aria-label="t('core.arbiterStopContext')">
          <UiDisclosureButton v-model:open="sourceOpen" :controls="`${inputId}-source`" block
                              data-role="arbiter-source-disclosure">
            {{ t('core.arbiterStopContext') }}
          </UiDisclosureButton>
          <div :id="`${inputId}-source`" class="ac-source-content">
            <div v-for="message in sourceMessages" :key="message.id" data-author="node">
              <span class="ac-author">{{ message.sourceKind === 'command'
                ? t('core.arbiterSourceCommand') : t('core.arbiterSourceNode') }}</span>
              <p :class="{ 'ac-source-preview': !sourceOpen }">{{ message.text }}</p>
            </div>
          </div>
        </section>

        <ol v-if="messages.length || analyzing" class="ac-messages"
            :aria-label="t('core.stageAnalysisConversation')">
          <li v-for="message in messages" :key="message.id" :data-author="message.author">
            <span class="ac-avatar" :data-author="message.author" aria-hidden="true">{{
              message.author === 'arbiter' ? '⚖' : message.author === 'human' ? '↳' : '·'
            }}</span>
            <div class="ac-message-body">
              <div class="ac-message-meta">
                <span class="ac-author">{{ authorLabels[message.author] }}</span>
                <span v-if="message.status === 'partial'" class="ac-message-state">
                  {{ t('core.arbiterWriting') }}
                </span>
                <time v-if="message.createdAt" :datetime="message.createdAt">
                  {{ messageTime(message.createdAt) }}
                </time>
              </div>
              <p>{{ message.author === 'arbiter' ? arbiterMessageText(message.text) : message.text }}</p>
            </div>
          </li>
          <li v-if="preparingReply" class="ac-thinking" data-role="arbiter-thinking">
            <span class="ac-avatar" data-author="arbiter" aria-hidden="true">⚖</span>
            <div class="ac-message-body">
              <span class="ac-author">{{ t('core.arbiterSourceArbiter') }}</span>
              <p><UiSpinner decorative /> {{ t('core.arbiterPreparingReply') }}</p>
            </div>
          </li>
        </ol>
        <section v-if="legacyCard?.card" class="ac-legacy">
          <h4>{{ t('core.arbiterHistorical') }}</h4>
          <p v-for="(text, key) in legacyCard.card" :key="key">{{ text }}</p>
        </section>

        <div v-if="!messages.length && !analyzing && !legacyCard?.card" class="ac-empty">
          <span class="ac-empty-icon" aria-hidden="true">↳</span>
          <h4>{{ t('core.stageAnalysisEmptyTitle') }}</h4>
          <p>{{ t('core.stageAnalysisEmptyHint') }}</p>
        </div>
        <template v-if="identity && !readOnly">
          <section v-for="question in questions" :key="question.id" class="ac-question"
                   :aria-labelledby="`${inputId}-${question.id}-heading`">
            <div class="ac-question-heading">
              <h4 :id="`${inputId}-${question.id}-heading`">{{ question.text }}</h4>
              <p class="ac-question-hint">{{ t('core.arbiterQuestionHint') }}</p>
            </div>
            <div class="ac-question-options">
              <UiButton v-for="option in question.options" :key="option.id" block wrap
                        data-context="arbiter-question-option" :disabled="!canDiscuss"
                        :tone="option.recommended ? 'success' : 'neutral'"
                        :variant="option.recommended ? 'solid' : 'outline'"
                        @click="send('discuss', { questionId: question.id, optionId: option.id })">
                <span class="ac-option-copy">
                  <span v-if="option.recommended" class="ac-option-recommendation">
                    <span aria-hidden="true">✓</span> {{ t('core.arbiterRecommended') }}
                  </span>
                  <span>{{ option.label }}</span>
                </span>
                <template #trailing><span aria-hidden="true">→</span></template>
              </UiButton>
            </div>
            <div class="ac-question-custom">
              <label :for="`${inputId}-${question.id}`">{{ t('core.arbiterCustomAnswer') }}</label>
              <UiTextarea :id="`${inputId}-${question.id}`" v-model="draft.answers[question.id]" rows="2"
                          data-context="workspace-note" :maxlength="ARBITER_LIMITS.humanText" />
              <div class="ac-question-submit">
                <UiButton wrap data-context="workspace-form-wrap"
                          :disabled="!canDiscuss || !draft.answers[question.id]?.trim()"
                          @click="answerQuestion(question.id)">
                  {{ t('core.arbiterSend') }}
                </UiButton>
              </div>
            </div>
          </section>

          <div v-if="doc && draft" class="ac-composer">
            <label :for="inputId">{{ t('core.arbiterDiscuss') }}</label>
            <UiTextarea :id="inputId" ref="composer" v-model="draft.text" rows="2"
                        data-context="workspace-note" data-role="arbiter-discuss-input"
                        :placeholder="t('core.stageInstructionPlaceholder')"
                        :maxlength="ARBITER_LIMITS.humanText" @keydown.ctrl.enter.prevent="discuss" />
            <div class="ac-actions">
              <UiButton wrap data-context="workspace-form-wrap" data-role="arbiter-discuss"
                        :disabled="!canDiscuss || !draft.text.trim()" variant="solid" tone="accent"
                        @click="discuss">
                {{ t('core.arbiterSend') }}
              </UiButton>
              <UiButton v-if="capabilities?.status === 'supported'" wrap data-context="workspace-form-wrap"
                        :disabled="busy || pending" variant="text" @click="draft.custom = !draft.custom">
                {{ t('core.arbiterCustomInstruction') }}
              </UiButton>
            </div>
            <div v-if="draft.custom && capabilities?.status === 'supported'" class="ac-custom">
              <label :for="`${inputId}-target`">{{ t('core.arbiterTarget') }}</label>
              <UiSelect :id="`${inputId}-target`" v-model="draft.targetNode">
                <option value="">{{ t('core.arbiterTarget') }}</option>
                <option v-for="target in instructionTargets" :key="target.node" :value="target.node">
                  {{ target.label }}
                </option>
              </UiSelect>
              <label :for="`${inputId}-instruction`">{{ t('core.arbiterInstruction') }}</label>
              <UiTextarea :id="`${inputId}-instruction`" v-model="draft.instruction" rows="4"
                          data-role="arbiter-custom-input" :maxlength="ARBITER_LIMITS.instruction" />
              <p v-if="customAction" class="ac-consequences">{{ consequences(customAction) }}</p>
              <UiButton wrap data-context="workspace-form-wrap" :disabled="!canApply || !customAction"
                        data-role="arbiter-custom-apply" @click="applyCustom">
                {{ t('core.arbiterApply') }}
              </UiButton>
            </div>
          </div>
        </template>

        <div v-if="doc" class="ac-technical-section">
          <UiDisclosureButton v-model:open="technicalOpen" :controls="`${inputId}-technical`">
            {{ t('core.arbiterTechnical') }}
          </UiDisclosureButton>
          <div v-if="technicalOpen" :id="`${inputId}-technical`">
            <pre class="ac-technical">{{ doc.result?.technicalDetails }}</pre>
            <a :href="journalUrl" target="_blank" rel="noopener noreferrer" download>
              {{ t('core.arbiterFullJournal') }}
            </a>
            <p>{{ t('core.arbiterJournalScope') }}</p>
          </div>
        </div>
      </div>
      <aside v-if="showDecisions" class="ac-decisions">
        <div class="ac-decision-heading">
          <span class="ac-decision-icon" aria-hidden="true">↗</span>
          <h4>{{ t('core.stageAnalysisDecision') }}</h4>
        </div>
        <div v-if="analysisFailure" ref="failurePanel" class="ac-failure" role="alert"
             data-role="arbiter-analysis-failure">
          <strong>{{ t('core.arbiterAnalysisFailed') }}</strong>
          <p>{{ analysisFailure }}</p>
          <p>{{ t('core.arbiterAnalysisRecovery') }}</p>
        </div>
        <p v-else-if="!doc?.result" class="ac-decision-empty">
          {{ t('core.stageAnalysisDecisionHint') }}
        </p>
        <div v-if="identity && !readOnly && (!doc || doc.state === 'idle' || doc.state === 'interrupted')"
             class="ac-start">
          <UiButton wrap data-context="workspace-form-wrap" :disabled="busy || pending"
                    data-role="arbiter-start"
                    variant="solid" tone="accent" @click="send('start')">
            {{ doc && doc.state !== 'idle' ? t('core.arbiterRetryAnalysis') : t('core.arbiterStart') }}
          </UiButton>
        </div>
        <div v-if="store.pending[task]" class="ac-pending">
          <p>{{ t('core.arbiterPending') }}</p>
          <UiButton wrap data-context="workspace-form-wrap" :disabled="busy" @click="reload">
            {{ t('core.arbiterCheckState') }}
          </UiButton>
          <UiButton wrap data-context="workspace-form-wrap" :disabled="busy" @click="retryRequest">
            {{ t('core.arbiterRetryRequest') }}
          </UiButton>
        </div>

        <template v-if="identity && !readOnly">
          <div v-if="capabilities?.message || capabilities?.status !== 'supported'" class="ac-compatibility">
            <p v-if="capabilities?.message" class="ac-notice">{{ capabilities.message }}</p>
            <UiButton v-if="capabilities?.status !== 'supported'" wrap data-context="workspace-form-wrap"
                      :disabled="busy" variant="text" @click="reload">
              {{ t('core.arbiterCheckSupport') }}
            </UiButton>
          </div>
          <section v-for="proposal in doc?.result?.proposals || []" :key="proposal.id" class="ac-proposal">
            <h4>
              {{ proposal.label }}
              <span v-if="proposal.recommended">· {{ t('core.arbiterRecommended') }}</span>
            </h4>
            <p>{{ proposal.explanation }}</p>
            <p v-if="proposal.expectedResult !== proposal.explanation">{{ proposal.expectedResult }}</p>
            <p v-if="proposal.kind === 'apply'" class="ac-consequences">
              {{ consequences(proposal.action) }}
            </p>
            <div class="ac-actions">
              <UiButton wrap data-context="workspace-form-wrap"
                        :disabled="proposal.kind === 'apply' ? !canApply : !canDiscuss"
                        :tone="proposal.recommended ? 'success' : 'neutral'"
                        :variant="proposal.recommended ? 'solid' : 'outline'"
                        :data-role="`arbiter-${proposal.kind}`"
                        @click="send(proposal.kind, { proposalId: proposal.id })">
                {{ proposal.kind === 'apply'
                  ? `${t('core.arbiterApply')} · ${targetLabel(proposal.action)}` : proposal.label }}
              </UiButton>
              <UiButton v-if="proposal.kind === 'apply' && proposal.action.kind !== 'retry_command'" wrap
                        data-context="workspace-form-wrap" :disabled="busy || !canApply" variant="text"
                        @click="edit(proposal)">
                {{ t('core.arbiterEditProposal') }}
              </UiButton>
            </div>
          </section>
        </template>
        <UiButton v-if="resumable" wrap data-context="workspace-form-wrap" :disabled="busy || pending"
                  data-role="arbiter-resume" @click="resume">
          {{ t('core.arbiterResumeOnly') }}
        </UiButton>
        <UiButton v-if="readOnly" wrap data-context="workspace-form-wrap" variant="text" @click="openCurrent">
          {{ t('core.arbiterNewStop') }}
        </UiButton>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';

import { UiButton, UiDisclosureButton, UiSelect, UiSpinner, UiTextarea, t, uiLocale } from '../../ui.ts';
import {
  ARBITER_LIMITS, arbiterMessageText, sameStop,
} from '../../../../shared/pipeline/arbiterConversation.ts';
import type {
  ArbiterAction,
  ArbiterMessage,
  ArbiterProposal,
  ArbiterQuestion,
  ArbiterConversationSummary,
} from '../../../../shared/pipeline/arbiterConversation.ts';
import { useArbiterConversationsStore } from '../../stores/arbiterConversations.ts';
import { formatDate } from '../../../../shared/i18n/formats.ts';
import type { ArbiterRun } from '../../../../shared/pipeline/factoryGraphContracts.ts';
import type { ArbiterCard } from '../../shared/pipelineContracts.ts';

const props = defineProps<{
  task: string;
  node: string;
  conversationId?: string;
  history?: ArbiterConversationSummary[];
  legacyCard?: ArbiterCard | null;
  arbitrating?: ArbiterRun | null;
}>();

const emit = defineEmits<{ 'current-stop': [] }>();
const store = useArbiterConversationsStore();
const inputId = `arbiter-${useId()}`;

const technicalOpen = ref(false);
const sourceOpen = ref(false);
const localError = ref('');
const composer = ref<InstanceType<typeof UiTextarea> | null>(null);
const failurePanel = ref<HTMLElement | null>(null);
const openedId = ref(props.conversationId || '');

const current = computed(() => store.currentByTask[props.task]);
const historyChoices = computed(() => (props.history || [])
  .filter((row) => row.identity.node === props.node
    && !sameStop(row.identity, current.value?.identity))
  .sort((left, right) => left.identity.stageSequence - right.identity.stageSequence));
const selectedHistory = computed(() => historyChoices.value
  .some((row) => row.conversationId === openedId.value) ? openedId.value : '');
const doc = computed(() => store.document(props.task, openedId.value || current.value?.conversationId || ''));
const questions = computed(() => (doc.value?.result?.questions || []).map((question) => ({
  ...question,
  options: question.options.map(questionOption),
})));
const journalUrl = computed(() => `/api/tasks/${encodeURIComponent(props.task)}/arbiter-conversations/`
  + `${encodeURIComponent(doc.value?.id || '')}/journal`);
const identity = computed(() => doc.value?.identity
  || (current.value?.identity?.node === props.node ? current.value.identity : null));
const draft = computed(() => identity.value ? store.draftFor(identity.value) : null!);
const capabilities = computed(() => sameStop(current.value?.identity, identity.value)
  ? current.value?.capabilities : doc.value?.capabilities);
const readOnly = computed(() => Boolean(doc.value?.readOnly || doc.value?.state === 'stale'
  || openedId.value && !doc.value
  || identity.value && !sameStop(current.value?.identity, identity.value)));
const pending = computed(() => Boolean(store.pending[props.task]));
const busy = computed(() => Boolean(store.sending[props.task]
  || doc.value?.state === 'analyzing' || doc.value?.state === 'applying'));
const analyzing = computed(() => !readOnly.value && (doc.value
  ? doc.value.state === 'analyzing' : Boolean(props.arbitrating)));
const showDecisions = computed(() => !analyzing.value || pending.value);
const sourceMessages = computed(() => doc.value?.messages
  .filter((message) => message.author === 'node') || []);
const messages = computed(() => {
  const rows: Pick<ArbiterMessage, 'id' | 'author' | 'text' | 'createdAt' | 'status'>[] =
    doc.value?.messages.filter((message) => message.author !== 'node') || [];
  const summary = doc.value?.result?.summary;

  if (summary && !rows.some((message) => message.author === 'arbiter'
    && arbiterMessageText(message.text) === summary.trim())) {
    return [...rows, {
      id: 'result-summary',
      author: 'arbiter' as const,
      text: summary,
      createdAt: '',
      status: 'complete' as const,
    }];
  }

  return rows;
});
const preparingReply = computed(() => analyzing.value && !messages.value
  .some((message) => message.author === 'arbiter' && message.status === 'partial'));
const canDiscuss = computed(() => Boolean(doc.value && !readOnly.value && !busy.value && !pending.value));
const canApply = computed(() => canDiscuss.value && capabilities.value?.status === 'supported');
const instructionTargets = computed(() => capabilities.value?.targets
  .filter((target) => target.acceptsInstruction)
  || []);
const error = computed(() => localError.value || store.errors[props.task] || store.storageError);
const analysisFailure = computed(() => {
  if (doc.value?.state !== 'interrupted') {
    return '';
  }

  const operation = doc.value.operations.at(-1);

  if (operation && !['start', 'discuss', 'diagnose'].includes(operation.kind)) {
    return '';
  }

  const message = [...doc.value.messages].reverse()
    .find((row) => row.author === 'system' && (!row.turnId || row.turnId === operation?.id));

  return operation?.message || message?.text || t('core.arbiterInterrupted');
});
const resumable = computed(() => [...(doc.value?.operations
  || [])].reverse().find((row) => row.kind === 'apply'

    && row.receipt
    && ['resume_failed', 'accepted'].includes(row.outcome)

    && !['superseded', 'completed', 'stopped'].includes(row.observation || '')));
const customAction = computed<ArbiterAction | null>(() => {
  if (!draft.value?.instruction.trim()
    || !instructionTargets.value.some((row) => row.node === draft.value.targetNode)) {
    return null;
  }

  return {
    kind: draft.value.targetNode === props.node ? 'replay_current' : 'return_to_node',
    targetNode: draft.value.targetNode,
    instruction: draft.value.instruction
  };
});
const authorLabels = computed(() => ({
  node: t('core.arbiterSourceNode'),
  arbiter: t('core.arbiterSourceArbiter'),
  human: t('core.arbiterSourceHuman'),
  system: t('core.arbiterSourceSystem')
}));
const status = computed(() => {
  if (openedId.value && !doc.value) {
    return t('core.loading');
  }

  if (readOnly.value) {
    return t('core.arbiterStale');
  }

  if (analyzing.value) {
    return t('core.arbiterConnected');
  }

  const labels = {
    idle: t('core.stageAnalysisReady'),
    analyzing: t('core.arbiterConnected'),
    awaiting_user: t('core.arbiterAwaiting'),
    applying: t('core.arbiterApplying'),
    resolved: t('core.arbiterResolved'),
    interrupted: t('core.arbiterInterrupted'),
    stale: t('core.arbiterStale'),
  };

  return doc.value ? labels[doc.value.state] : identity.value ? labels.idle : t('core.arbiterNoStop');
});

/**
 * У вариантов вопроса рекомендация хранится в конце подписи, отдельного поля в контракте нет.
 * Явная пометка RU/EN становится значком; исходные данные и порядок вариантов сохраняются.
 */
function questionOption(option: ArbiterQuestion['options'][number]) {
  const marker = /\s*\((?:рекомендуется|рекомендую|рекомендуем|recommended)\)\s*$/iu;
  const recommended = marker.test(option.label);

  return {
    ...option,
    recommended,
    label: recommended ? option.label.replace(marker, '').trim() || option.label : option.label,
  };
}

/**
 * Время реплики показывается в локали и часовом поясе устройства.
 * Старые сообщения без корректной даты остаются читаемыми без выдуманного времени.
 */
function messageTime(value: string) {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? '' : formatDate(date, uiLocale, { timeStyle: 'short' });
}

const targetLabel = (action: ArbiterAction) => capabilities.value?.targets
  .find((row) => row.node === action.targetNode)
  ?.label
  || action.targetNode;

/**
 * Последствия берутся из серверной проекции закреплённого маршрута.
 * Модельный текст не выбирает реальный этап и пересчитываемый хвост.
 */
function consequences(action: ArbiterAction) {
  if (action.kind === 'retry_command') {
    return t('core.arbiterRetryCommand');
  }

  const target = capabilities.value?.targets.find((row) => row.node === action.targetNode);

  return t('core.arbiterConsequences', {
    stage: targetLabel(action),
    stages: (target?.resetLabels || target?.resetNodes || []).join(', '),
  });
}

/**
 * Отправка не очищает черновик до доказанного ответа сервера.
 * Изменённый во время ожидания текст остаётся человеку для следующего хода.
 */
async function send(kind: string, payload: Record<string, unknown> = {}) {
  localError.value = '';

  try {
    return await store.send(props.task, doc.value?.id || null, kind, payload);
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Обычный ввод всегда продолжает обсуждение независимо от повелительных слов в тексте.
 * Подтверждённый ответ очищает только отправленный снимок, сохраняя более новый черновик.
 */
async function discuss() {
  const text = draft.value?.text;

  if (!text?.trim() || !canDiscuss.value) {
    return;
  }

  if (await send('discuss', { text }) && draft.value.text === text) {
    draft.value.text = '';
  }
}

async function answerQuestion(questionId: string) {
  const answer = draft.value.answers[questionId];

  if (await send(
    'discuss',
    {
      questionId,
      customAnswer: answer
    }
  )
    && draft.value.answers[questionId] === answer) {
    draft.value.answers[questionId] = '';
  }
}

function edit(proposal: ArbiterProposal) {
  if (proposal.kind === 'apply' && proposal.action.kind !== 'retry_command') {
    draft.value.custom = true;
    draft.value.targetNode = proposal.action.targetNode;
    draft.value.instruction = proposal.action.instruction;
    draft.value.originalProposalId = proposal.id;
  }
}

/**
 * Отдельная кнопка передаёт собственное указание только в допустимый этап агента.
 * Изменённое предложение сохраняет ссылку на исходный вариант для аудита.
 */
function applyCustom() {
  if (customAction.value) {
    void send('apply', {
      customAction: customAction.value,
      ...(draft.value.originalProposalId ? { originalProposalId: draft.value.originalProposalId } : {})
    });
  }
}

function resume() {
  const operation = resumable.value;

  if (operation?.receipt) {
    void send('resume', {
      applyOperationId: operation.id,
      acceptedEvent: operation.receipt.stage,
      expectedCurrentStage: operation.receipt.stage
    });
  }
}

/**
 * Перечитывает состояние и повторяет read-only probe без нового хода модели.
 * Ошибка не очищает ни историю, ни набранный человеком текст.
 */
async function reload() {
  localError.value = '';

  try {
    await store.open(props.task, openedId.value || props.conversationId);
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Исторический выбор читает сохранённый документ без создания нового хода.
 * Возврат к текущей остановке снимает локальный id, закреплённый открытым старым окном.
 */
async function selectHistory(value: string | number | null) {
  openedId.value = value === null ? '' : String(value);
  localError.value = '';
  sourceOpen.value = false;

  try {
    await store.open(props.task, openedId.value || undefined);
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Кнопка новой остановки открывает актуальную identity, даже если node не изменился.
 * Старые предложения остаются только в сохранённом документе истории.
 */
async function openCurrent() {
  await selectHistory('');
  emit('current-stop');
}

/**
 * После обрыва отправляет сохранённый запрос с прежним UUID и payload.
 * Новый intent из этой кнопки не создаётся даже после перезагрузки окна.
 */
async function retryRequest() {
  try {
    await store.retryPending(props.task);
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error);
  }
}

watch(() => [props.task, props.node, props.conversationId], async () => {
  openedId.value = props.conversationId || '';
  sourceOpen.value = false;
  await reload();
  openedId.value ||= doc.value?.id || '';
  await nextTick();
  composer.value?.focus({ preventScroll: true });
}, { immediate: true });

watch(() => doc.value?.id, (id) => {
  openedId.value ||= id || '';
});

// Ошибка нового хода остаётся видимой и после чтения длинной истории.
// Прокрутка не забирает клавиатурный фокус у черновика обсуждения.
watch(analysisFailure, async (message) => {
  if (message) {
    await nextTick();
    failurePanel.value?.scrollIntoView({ block: 'start' });
  }
}, { immediate: true });
</script>

<style scoped>
.ac {
  display: flex;
  flex: 1;
  min-width: 0;
  width: 100%;
  min-height: 100%;
  overflow-wrap: anywhere;
}
.ac-layout {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  min-height: inherit;
}
.ac-layout--single {
  grid-template-columns: minmax(0, 1fr);
}
.ac-thread {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
  padding: 18px;
}
.ac-heading {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ac-heading-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.ac-model {
  margin-left: auto;
  color: var(--ink-mid);
  font-size: 11px;
}
.ac h3, .ac h4, .ac p {
  margin: 0;
}
.ac h3 {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -.025em;
}
.ac p {
  white-space: pre-wrap;
  line-height: 1.55;
}
.ac-status, .ac-author, .ac-automatic {
  color: var(--ink-mid);
  font-size: 11px;
}
.ac-status {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ac-automatic {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.ac-avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 16px;
}
.ac-avatar[data-author="arbiter"] {
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
  color: var(--accent);
}
.ac-avatar[data-author="human"] {
  background: color-mix(in srgb, var(--ink-mid) 12%, var(--surface));
  color: var(--ink);
}
.ac-source {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--ground) 25%, var(--surface));
}
.ac-source-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 12px 12px;
  color: var(--ink-mid);
  font-size: 12px;
}
.ac-source-content .ac-author {
  display: block;
  margin-bottom: 4px;
}
.ac-source p.ac-source-preview {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  white-space: normal;
}
.ac-error {
  padding: 12px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bad) 8%, transparent);
  color: var(--bad);
  font-size: 12px;
}
.ac-decisions {
  position: sticky;
  top: 0;
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 18px 16px;
  border-left: 1px solid var(--line);
  background: color-mix(in srgb, var(--ground) 46%, var(--surface));
}
.ac-failure {
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--bad);
  font-size: 12px;
}
.ac-decision-heading {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ac-decision-heading h4 {
  font-size: 14px;
  font-weight: 600;
}
.ac-decision-icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--ink-mid);
  font-size: 18px;
}
.ac-notice, .ac-decision-empty {
  color: var(--ink-mid);
  font-size: 12px;
}
.ac-compatibility {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.ac-consequences {
  padding: 10px 12px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--warn) 7%, transparent);
  color: var(--ink-mid);
  font-size: 11px;
}
.ac-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 14px 24px 0;
  text-align: center;
}
.ac-empty-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--line));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  color: var(--accent);
  font-size: 22px;
}
.ac-empty h4 {
  font-size: 16px;
  font-weight: 550;
}
.ac-empty p {
  max-width: 47ch;
  color: var(--ink-mid);
  font-size: 12px;
}
.ac-start {
  display: flex;
  justify-content: flex-start;
}
.ac-messages {
  display: flex;
  flex-direction: column;
  gap: 18px;
  list-style: none;
  padding: 0;
  margin: 0;
}
.ac-messages:empty {
  display: none;
}
.ac-messages li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  font-size: 13px;
}
.ac-messages li[data-author="human"] {
  align-self: flex-end;
  flex-direction: row-reverse;
  max-width: 88%;
}
.ac-message-body {
  min-width: 0;
  flex: 1;
}
.ac-message-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin: 2px 0 6px;
}
.ac-message-meta time, .ac-message-state {
  color: var(--ink-mid);
  font-size: 10px;
}
.ac-messages li[data-author="arbiter"] .ac-author {
  color: var(--accent);
}
.ac-messages li[data-author="human"] .ac-message-body {
  padding: 8px 12px;
  border-radius: 10px 2px 10px 10px;
  background: var(--surface-2);
}
.ac-messages li[data-author="system"] {
  color: var(--ink-mid);
  font-size: 11px;
}
.ac-thinking p {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
  color: var(--ink-mid);
  font-size: 12px;
}
.ac-author {
  font-weight: 600;
}
.ac-composer, .ac-custom, .ac-question, .ac-proposal, .ac-pending, .ac-legacy, .ac-history {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.ac-composer {
  padding: 12px 0;
  border-top: 1px solid var(--line);
  background: var(--surface);
  gap: 8px;
}
.ac-composer label, .ac-question label, .ac-history label {
  color: var(--ink-mid);
  font-size: 12px;
}
.ac-proposal {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
}
.ac-proposal h4, .ac-question h4 {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}
.ac-proposal p {
  color: var(--ink-mid);
  font-size: 12px;
}
.ac-question {
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--ground) 25%, var(--surface));
}
.ac-question-heading {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ac-question-hint {
  color: var(--ink-mid);
  font-size: 11px;
}
.ac-question-options {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
.ac-option-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.ac-option-recommendation {
  font-size: 10px;
  font-weight: 600;
}
.ac-question-custom {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.ac-question-submit {
  display: flex;
  justify-content: flex-end;
}
.ac-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ac-technical-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ac-technical {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--ink-mid);
  font-size: 11px;
}
@media (max-width: 980px) {
  .ac-layout {
    grid-template-columns: minmax(0, 1fr) 300px;
  }
  .ac-layout--single {
    grid-template-columns: minmax(0, 1fr);
  }
  .ac-thread {
    padding: 16px;
  }
  .ac-decisions {
    padding: 14px 12px;
  }
}
@media (max-width: 700px) {
  .ac-layout {
    display: flex;
    flex-direction: column;
  }
  .ac-thread, .ac-decisions {
    padding: 14px 12px;
  }
  .ac-decisions {
    order: -1;
    position: static;
    align-self: stretch;
    border-left: 0;
    border-bottom: 1px solid var(--line);
  }
  .ac-empty {
    padding: 10px 0 0;
  }
  .ac-question {
    padding: 12px;
  }
  .ac-heading {
    flex-wrap: wrap;
  }
  .ac-model {
    width: 100%;
    padding-left: 38px;
  }
  .ac-messages li[data-author="human"] {
    max-width: 94%;
  }
}
</style>
