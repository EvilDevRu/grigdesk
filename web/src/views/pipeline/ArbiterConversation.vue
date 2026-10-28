<template>
  <section class="ac" data-role="arbiter-conversation" :aria-label="t('core.arbiterDialogTitle')">
    <h3>{{ t('core.arbiterDialogTitle') }}</h3>
    <p v-if="doc?.automatic" class="ac-notice">{{ t('core.arbiterAutomaticNotice') }}</p>
    <p class="ac-status" role="status" aria-live="polite">{{ status }}</p>
    <p v-if="error" class="ac-error" role="alert">{{ error }}</p>

    <div v-if="historyChoices.length" class="ac-history">
      <label :for="`${inputId}-history`">{{ t('core.arbiterHistory') }}</label>
      <UiSelect :id="`${inputId}-history`" :model-value="selectedHistory" @update:model-value="selectHistory">
        <option value="">{{ t('core.arbiterCurrentStop') }}</option>
        <option v-for="(item, index) in historyChoices" :key="item.conversationId"
                :value="item.conversationId">{{ t('core.arbiterEarlierAnalysis', { number: index + 1 }) }}</option>
      </UiSelect>
    </div>

    <ol v-if="doc" class="ac-messages" aria-live="off">
      <li v-for="message in doc.messages" :key="message.id" :data-author="message.author">
        <span class="ac-author">{{ message.author === 'node' && message.sourceKind === 'command'
          ? t('core.arbiterSourceCommand') : authorLabels[message.author] }}</span>
        <p>{{ message.text }}</p>
      </li>
    </ol>
    <p v-if="doc?.result?.summary && !doc.messages.some((row) => row.text === doc?.result?.summary)"
       class="ac-summary">{{ doc.result.summary }}</p>

    <section v-if="legacyCard?.card" class="ac-legacy">
      <h4>{{ t('core.arbiterHistorical') }}</h4>
      <p v-for="(text, key) in legacyCard.card" :key="key">{{ text }}</p>
    </section>

    <div v-if="store.pending[task]" class="ac-pending">
      <p>{{ t('core.arbiterPending') }}</p>
      <UiButton :disabled="busy" @click="reload">{{ t('core.arbiterCheckState') }}</UiButton>
      <UiButton :disabled="busy" @click="retryRequest">{{ t('core.arbiterRetryRequest') }}</UiButton>
    </div>

    <template v-if="identity && !readOnly">
      <UiButton v-if="!doc || doc.state === 'idle' || doc.state === 'interrupted'"
                :disabled="busy || pending" data-role="arbiter-start" @click="send('start')">
        {{ doc && doc.state !== 'idle' ? t('core.arbiterRetryAnalysis') : t('core.arbiterStart') }}
      </UiButton>
      <p v-if="capabilities?.message" class="ac-notice">{{ capabilities.message }}</p>
      <UiButton v-if="capabilities?.status !== 'supported'" :disabled="busy" @click="reload">
        {{ t('core.arbiterCheckSupport') }}
      </UiButton>

      <section v-for="question in doc?.result?.questions || []" :key="question.id" class="ac-question">
        <h4>{{ question.text }}</h4>
        <div class="ac-actions">
          <UiButton v-for="option in question.options" :key="option.id" :disabled="!canDiscuss"
                    @click="send('discuss', { questionId: question.id, optionId: option.id })">
            {{ option.label }}
          </UiButton>
        </div>
        <label :for="`${inputId}-${question.id}`">{{ t('core.arbiterCustomAnswer') }}</label>
        <UiTextarea :id="`${inputId}-${question.id}`" v-model="draft.answers[question.id]" rows="2"
                    :maxlength="ARBITER_LIMITS.humanText" />
        <UiButton :disabled="!canDiscuss || !draft.answers[question.id]?.trim()"
                  @click="answerQuestion(question.id)">{{ t('core.arbiterSend') }}</UiButton>
      </section>

      <section v-for="proposal in doc?.result?.proposals || []" :key="proposal.id" class="ac-proposal">
        <h4>{{ proposal.label }} <span v-if="proposal.recommended">· {{ t('core.arbiterRecommended') }}</span></h4>
        <p>{{ proposal.explanation }}</p>
        <p>{{ proposal.expectedResult }}</p>
        <p v-if="proposal.kind === 'apply'" class="ac-consequences">{{ consequences(proposal.action) }}</p>
        <div class="ac-actions">
          <UiButton :disabled="proposal.kind === 'apply' ? !canApply : !canDiscuss"
                    :data-role="`arbiter-${proposal.kind}`"
                    @click="send(proposal.kind, { proposalId: proposal.id })">
            {{ proposal.kind === 'apply' ? `${t('core.arbiterApply')} · ${targetLabel(proposal.action)}`
              : proposal.label }}
          </UiButton>
          <UiButton v-if="proposal.kind === 'apply' && proposal.action.kind !== 'retry_command'"
                    :disabled="busy || !canApply" variant="text" @click="edit(proposal)">
            {{ t('core.arbiterEditProposal') }}
          </UiButton>
        </div>
      </section>

      <div v-if="doc && draft" class="ac-composer">
        <label :for="inputId">{{ t('core.arbiterDiscuss') }}</label>
        <UiTextarea :id="inputId" ref="composer" v-model="draft.text" rows="3"
                    data-role="arbiter-discuss-input" :maxlength="ARBITER_LIMITS.humanText"
                    @keydown.ctrl.enter.prevent="discuss" />
        <div class="ac-actions">
          <UiButton :disabled="!canDiscuss || !draft.text.trim()" data-role="arbiter-discuss" @click="discuss">
            {{ t('core.arbiterSend') }}
          </UiButton>
          <UiButton v-if="capabilities?.status === 'supported'" :disabled="busy || pending"
                    variant="text" @click="draft.custom = !draft.custom">
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
          <UiButton :disabled="!canApply || !customAction" data-role="arbiter-custom-apply"
                    @click="applyCustom">{{ t('core.arbiterApply') }}</UiButton>
        </div>
      </div>
    </template>

    <UiButton v-if="resumable" :disabled="busy || pending" data-role="arbiter-resume" @click="resume">
      {{ t('core.arbiterResumeOnly') }}
    </UiButton>
    <UiButton v-if="readOnly" variant="text" @click="openCurrent">
      {{ t('core.arbiterNewStop') }}
    </UiButton>
    <UiDisclosureButton v-if="doc" v-model:open="technicalOpen"
                        :controls="`${inputId}-technical`">{{ t('core.arbiterTechnical') }}</UiDisclosureButton>
    <div v-if="technicalOpen && doc" :id="`${inputId}-technical`">
      <pre class="ac-technical">{{ doc.result?.technicalDetails }}</pre>
      <a :href="journalUrl" target="_blank" rel="noopener noreferrer" download>
        {{ t('core.arbiterFullJournal') }}
      </a>
      <p>{{ t('core.arbiterJournalScope') }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';

import { UiButton, UiDisclosureButton, UiSelect, UiTextarea, t } from '../../ui.ts';
import { ARBITER_LIMITS, sameStop } from '../../../../shared/pipeline/arbiterConversation.ts';
import type {
  ArbiterAction,
  ArbiterProposal,
  ArbiterConversationSummary,
} from '../../../../shared/pipeline/arbiterConversation.ts';
import { useArbiterConversationsStore } from '../../stores/arbiterConversations.ts';
import type { ArbiterCard } from '../../shared/pipelineContracts.ts';

const props = defineProps<{
  task: string;
  node: string;
  conversationId?: string;
  history?: ArbiterConversationSummary[];
  legacyCard?: ArbiterCard | null
}>();
const emit = defineEmits<{ 'current-stop': [] }>();
const store = useArbiterConversationsStore();
const inputId = `arbiter-${useId()}`;
const technicalOpen = ref(false);
const localError = ref('');
const composer = ref<InstanceType<typeof UiTextarea> | null>(null);
const openedId = ref(props.conversationId || '');
const current = computed(() => store.currentByTask[props.task]);
const historyChoices = computed(() => (props.history || [])
  .filter((row) => row.identity.node === props.node
    && !sameStop(row.identity, current.value?.identity))
  .sort((left, right) => left.identity.stageSequence - right.identity.stageSequence));
const selectedHistory = computed(() => historyChoices.value
  .some((row) => row.conversationId === openedId.value) ? openedId.value : '');
const doc = computed(() => store.document(props.task, openedId.value || current.value?.conversationId || ''));
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
const canDiscuss = computed(() => Boolean(doc.value && !readOnly.value && !busy.value && !pending.value));
const canApply = computed(() => canDiscuss.value && capabilities.value?.status === 'supported');
const instructionTargets = computed(() => capabilities.value?.targets
  .filter((target) => target.acceptsInstruction)
  || []);
const error = computed(() => localError.value || store.errors[props.task] || store.storageError);
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

  const labels = {
    idle: t('core.arbiterDialogTitle'),
    analyzing: t('core.arbiterAnalyzing'),
    awaiting_user: t('core.arbiterAwaiting'),
    applying: t('core.arbiterApplying'),
    resolved: t('core.arbiterResolved'),
    interrupted: t('core.arbiterInterrupted'),
    stale: t('core.arbiterStale'),
  };

  return doc.value ? labels[doc.value.state] : identity.value ? labels.idle : t('core.arbiterNoStop');
});

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
  await reload();
  openedId.value ||= doc.value?.id || '';
  await nextTick();
  composer.value?.focus({ preventScroll: true });
}, { immediate: true });

watch(() => doc.value?.id, (id) => {
  openedId.value ||= id || '';
});
</script>

<style scoped>
.ac { min-width: 0; width: 100%; display: flex; flex-direction: column; gap: 14px; overflow-wrap: anywhere; }
.ac h3, .ac h4, .ac p { margin: 0; }
.ac p { white-space: pre-wrap; line-height: 1.55; }
.ac-status, .ac-author { color: var(--ink-mid); font-size: 12px; }
.ac-error { color: var(--bad); }
.ac-notice, .ac-consequences { padding: 10px 12px; background: var(--surface-2); }
.ac-messages { display: flex; flex-direction: column; gap: 16px; list-style: none; padding: 0; margin: 0; }
.ac-messages li { min-width: 0; border-left: 2px solid var(--line); padding-left: 12px; }
.ac-messages li[data-author="human"] { border-color: var(--accent); }
.ac-composer, .ac-custom, .ac-question, .ac-proposal, .ac-pending, .ac-legacy {
  display: flex; flex-direction: column; gap: 10px; min-width: 0;
}
.ac-proposal, .ac-question { border-top: 1px solid var(--line); padding-top: 14px; }
.ac-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.ac-actions > * { max-width: 100%; white-space: normal; }
.ac-technical { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
@media (max-width: 480px) { .ac-actions { flex-direction: column; align-items: stretch; } }
</style>
