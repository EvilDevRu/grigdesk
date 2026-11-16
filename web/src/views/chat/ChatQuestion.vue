<template>
  <ChatIntervention class="q" :heading="t('core.interventionQuestionTitle')" :source="source">
    <div v-if="structured && prompt" class="q-intro">
      <div v-if="prompt" class="q-prompt">{{ prompt }}</div>
    </div>

    <div
      v-for="(question, questionIndex) in questions"
      :key="question.key || questionIndex"
      class="q-item"
    >
      <div v-if="question.header || questions.length > 1" class="q-topic">
        <span v-if="questions.length > 1" class="q-number">{{ questionIndex + 1 }}</span>
        {{ question.header }}
      </div>
      <div class="q-text">
        {{ question.question }}
        <span v-if="structured && question.required" class="q-required">{{ t('core.chatObyazatelno') }}</span>
        <span v-if="question.multiSelect" class="q-multi">{{ t('core.chatMozhnoNeskolko') }}</span>
      </div>

      <div v-if="question.hint" class="q-hint">{{ question.hint }}</div>

      <template v-if="structured">
        <UiInput
          v-if="question.inputType === 'text'"
          v-model="state[questionIndex]!.value as string"
          class="q-own"
          :type="textInputType(question)"
          :required="question.required"
          :minlength="question.minLength"
          :maxlength="question.maxLength ?? 4000"
          :placeholder="question.placeholder || ''"
          :aria-label="question.header || question.question"
          @keydown.enter.prevent="ready && submitStructured('accept')"
        />

        <UiNumberInput
          v-else-if="question.inputType === 'number' || question.inputType === 'integer'"
          v-model="state[questionIndex]!.value as number | null"
          class="q-own"
          :required="question.required"
          :min="question.minimum"
          :max="question.maximum"
          :step="question.inputType === 'integer' ? 1 : 'any'"
          :aria-label="question.header || question.question"
          @keydown.enter.prevent="ready && submitStructured('accept')"
        />

        <UiChoiceList
          v-else-if="structuredChoices(question)"
          class="q-opts"
          :label="question.header || question.question"
          :mode="question.inputType === 'multi-choice' ? 'multiple' : 'single'"
          :model-value="structuredValue(questionIndex)"
          :options="structuredOptions(question)"
          selection-indicator
          @update:model-value="setStructuredValue(questionIndex, $event as QuestionValue | undefined)"
        />

        <div v-if="constraintText(question)" class="q-rule">
          {{ constraintText(question) }}
        </div>
        <UiTextarea
          v-if="question.inputType === 'choice-or-text'"
          v-model="state[questionIndex]!.value as string"
          class="q-own"
          data-context="workspace-note"
          :maxlength="question.maxLength ?? 4000"
          :aria-label="question.header || question.question"
          :rows="2"
          @keydown.ctrl.enter.prevent="ready && submitStructured('accept')"
          @keydown.meta.enter.prevent="ready && submitStructured('accept')"
        />
      </template>

      <template v-else>
        <UiChoiceList
          v-if="question.options?.length"
          class="q-opts"
          :label="question.header || question.question"
          :mode="question.multiSelect ? 'multiple' : 'single'"
          :model-value="pickedValue(questionIndex)"
          :options="optionsOf(question)"
          selection-indicator
          @update:model-value="setPicked(questionIndex, $event)"
        />

        <UiButton
          size="compact"
          v-if="freeText(question) && question.options?.length"
          class="q-own-toggle"
          variant="link"
          tone="neutral"
          :pressed="state[questionIndex]!.own"
          @click="toggleOwn(questionIndex)"
        > {{ t('core.chatSvoyOtvet') }} </UiButton>

        <UiTextarea
          v-if="freeText(question) && state[questionIndex]!.own"
          :ref="(field) => setOwnField(questionIndex, field)"
          v-model="state[questionIndex]!.text"
          class="q-own"
          data-context="workspace-note"
          :placeholder="t('core.chatNapishiSvoimiSlovami')"
          :aria-label="question.header || question.question"
          :rows="2"
          @keydown.ctrl.enter.prevent="ready && submit()"
          @keydown.meta.enter.prevent="ready && submit()"
        />
      </template>
    </div>

    <template #footer>
      <div class="q-footer">
        <span v-if="questions.length > 1" class="q-progress">
          {{ t('core.interventionProgress', { answered, total: questions.length }) }}
        </span>
        <UiFormActions class="q-act">
          <template v-if="structured">
            <UiButton
              size="compact"
              v-for="entry in acceptingActions"
              :key="entry.action"
              :variant="entry.action === 'accept' ? 'solid' : 'outline'"
              tone="accent"
              :disabled="!ready"
              @click="submitStructured(entry.action)"
            >
              {{ entry.label || actionLabel(entry.action) }}
            </UiButton>
            <UiButton
              size="compact"
              v-if="hasAction('decline')"
              tone="danger"
              @click="submitStructured('decline')"
            >
              {{ actionLabel('decline') }}
            </UiButton>
            <UiButton
              v-if="hasAction('cancel')"
              size="compact"
              variant="link"
              @click="submitStructured('cancel')"
            >
              {{ actionLabel('cancel') }}
            </UiButton>
          </template>
          <template v-else>
            <UiButton size="compact" variant="link" @click="emit('skip')">{{ t('core.chatPropustit') }}</UiButton>
            <UiButton
              size="compact"
              variant="solid"
              tone="accent"
              :disabled="!ready"
              @click="submit"
            > {{ t('core.chatOtvetit') }} </UiButton>
          </template>
        </UiFormActions>
      </div>
    </template>
  </ChatIntervention>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { PropType } from 'vue';
import type { ChatQuestion, ChatQuestionItem, QuestionValue } from '../../shared/chatContracts.ts';
import ChatIntervention from './ChatIntervention.vue';
import {
  t,
  UiButton,
  UiChoiceList,
  UiFormActions,
  UiInput,
  UiNumberInput,
  UiTextarea,
} from '../../ui';

// Диалог агента: он спросил по существу, а не запросил разрешение на действие.
const props = defineProps({
  req: {
    type: Object as PropType<ChatQuestion>,
    required: true,
  },
});
const emit = defineEmits(['answer', 'skip']);

interface QuestionState {
  picked: string[];
  text: string;
  own: boolean;
  value: QuestionValue | undefined;
}

const state = ref<QuestionState[]>([]);
const ownFields = new Map<number, { focus(): void }>();

watch(
  () => props.req?.pid,
  () => {
    state.value = (props.req?.questions || []).map((question) => ({
      picked: [],
      text: '',
      own: !question.options?.length,
      value: initialValue(question),
    }));
  },
  { immediate: true },
);

const questions = computed(() => props.req?.questions || []);
const structured = computed(() => props.req?.structured === true);
const source = computed(() => String(props.req?.source || ''));
const prompt = computed(() => String(props.req?.prompt || ''));
const answered = computed(() => questions.value.filter((question, index) => {
  const item = state.value[index];

  return structured.value
    ? item?.value !== ''
      && (!Array.isArray(item?.value) || item.value.length > 0)
      && hasStructuredValue(question, item?.value)
      && validStructured(question, item?.value)
    : Boolean(item?.picked.length || item?.text.trim());
}).length);
// Обычная анкета отправляется только целиком: счётчик и доступность используют один критерий.
// Structured-формы сохраняют свои required-ограничения и разрешённые пустые подтверждения.
const ready = computed(() => (structured.value
  ? questions.value.every((question, index) => validStructured(question, state.value[index]?.value))
  : questions.value.length > 0 && answered.value === questions.value.length));

const DEFAULT_ACTIONS = Object.freeze(['accept', 'cancel']);
const ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  get accept() {
    return t('core.send');
  },
  get accept_session() {
    return t('core.chatRazreshitNaSessiyu');
  },
  get accept_always() {
    return t('core.chatRazreshatVsegda');
  },
  get decline() {
    return t('core.deny');
  },
  get cancel() {
    return t('core.trackerCancel');
  },
});
const actions = computed(() => {
  const given = Array.isArray(props.req?.actions) ? props.req.actions : DEFAULT_ACTIONS;
  const normalized = given.map((entry) => (
    typeof entry === 'string'
      ? { action: entry, label: '' }
      : { action: entry?.action, label: String(entry?.label || '') }
  )).filter((entry) => Object.hasOwn(ACTION_LABELS, entry.action));

  return normalized.length ? normalized : DEFAULT_ACTIONS.map((action) => ({ action, label: '' }));
});
const acceptingActions = computed(() => (
  actions.value.filter((entry) => entry.action.startsWith('accept'))
));

/**
 * Начальное значение сохраняет тип default из вопроса.
 * Дата переводится в локальный формат только для соответствующего поля ввода.
 */
function initialValue(question: ChatQuestionItem) {
  if (Object.hasOwn(question || {}, 'default')) {
    if (question?.format === 'date-time' && typeof question.default === 'string') {
      return dateTimeInputValue(question.default);
    }

    return Array.isArray(question.default) ? [...question.default] : question.default;
  }
  if (question?.inputType === 'multi-choice') {
    return [];
  }
  if (question?.inputType === 'choice' || question?.inputType === 'boolean') {
    return null;
  }

  return '';
}

function freeText(question: ChatQuestionItem) {
  return question?.allowFreeText !== false;
}

function optionsOf(question: ChatQuestionItem) {
  return (question?.options || []).map((option) => ({
    value: String(option.label || ''),
    label: String(option.label || ''),
    description: option.description ? String(option.description) : undefined,
  }));
}

function structuredChoices(question: ChatQuestionItem) {
  return ['choice', 'choice-or-text', 'multi-choice', 'boolean'].includes(question?.inputType || '');
}

function structuredOptions(question: ChatQuestionItem) {
  if (question?.inputType === 'boolean') {
    return [
      { value: true, label: t('core.yes') },
      { value: false, label: t('core.chatNet') },
    ];
  }

  return (question?.options || []).map((option) => ({
    value: Object.hasOwn(option || {}, 'value') ? option.value! : String(option?.label || ''),
    label: String(option?.label ?? option?.value ?? ''),
    description: option?.description ? String(option.description) : undefined,
  }));
}

function structuredValue(questionIndex: number) {
  return state.value[questionIndex]?.value ?? null;
}

function setStructuredValue(questionIndex: number, value: QuestionValue | undefined) {
  const item = state.value[questionIndex];

  if (item) {
    item.value = value;
  }
}

/**
 * Определяет наличие ответа по типу поля, отдельно от проверки ограничений.
 * Пустая строка остаётся значением текстового поля, как в прежней форме.
 */
function hasStructuredValue(question: ChatQuestionItem, value: QuestionValue | undefined) {
  if (question?.inputType === 'text' || question?.inputType === 'choice-or-text') {
    return typeof value === 'string';
  }
  if (question?.inputType === 'multi-choice') {
    return Array.isArray(value);
  }
  if (question?.inputType === 'number' || question?.inputType === 'integer') {
    return typeof value === 'number';
  }
  if (question?.inputType === 'boolean') {
    return typeof value === 'boolean';
  }

  return value !== '' && value !== null && value !== undefined;
}

/**
 * Проверяет ограничения вопроса до разрешения отправки формы.
 * Необязательные пустые ответы сохраняют прежнее поведение пропуска.
 */
function validStructured(question: ChatQuestionItem, value: QuestionValue | undefined) {
  const present = hasStructuredValue(question, value);

  if (!present) {
    return !question?.required;
  }
  if (!question?.required && (value === '' || (Array.isArray(value) && !value.length))) {
    return true;
  }

  if (question?.inputType === 'text' || question?.inputType === 'choice-or-text') {
    if (typeof value !== 'string' || value.length > 4_000) {
      return false;
    }
    if (question.minLength !== undefined && value.length < question.minLength) {
      return false;
    }
    if (question.maxLength !== undefined && value.length > question.maxLength) {
      return false;
    }

    return validTextFormat(question.format, value);
  }
  if (question?.inputType === 'number' || question?.inputType === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return false;
    }
    if (question.inputType === 'integer' && !Number.isInteger(value)) {
      return false;
    }
    if (question.minimum !== undefined && value < question.minimum) {
      return false;
    }
    if (question.maximum !== undefined && value > question.maximum) {
      return false;
    }

    return true;
  }
  if (question?.inputType === 'boolean') {
    return typeof value === 'boolean';
  }

  const allowed = new Set<QuestionValue | undefined>(
    structuredOptions(question).map((option) => option.value),
  );

  if (question?.inputType === 'choice') {
    return allowed.has(value);
  }
  if (question?.inputType === 'multi-choice') {
    if (!Array.isArray(value) || !value.every((entry) => allowed.has(entry))) {
      return false;
    }
    if (question.minItems !== undefined && value.length < question.minItems) {
      return false;
    }
    if (question.maxItems !== undefined && value.length > question.maxItems) {
      return false;
    }

    return true;
  }

  return false;
}

function textInputType(question: ChatQuestionItem) {
  const types: Record<string, 'email' | 'url' | 'date' | 'datetime-local'> = {
    email: 'email',
    uri: 'url',
    date: 'date',
    'date-time': 'datetime-local',
  };

  return types[question?.format || ''] || 'text';
}

/**
 * Проверяет только объявленный формат текста, не изменяя введённую строку.
 * Ошибка даты или URL остаётся локальным отказом готовности формы.
 */
function validTextFormat(format: string | undefined, value: string) {
  if (!format) {
    return true;
  }
  if (format === 'email') {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }
  if (format === 'uri') {
    try {
      return !!new URL(value).protocol;
    } catch {
      return false;
    }
  }
  if (format === 'date') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

    if (!match) {
      return false;
    }

    const date = new Date(`${value}T00:00:00Z`);

    return !Number.isNaN(date.valueOf())
      && date.getUTCFullYear() === Number(match[1])
      && date.getUTCMonth() + 1 === Number(match[2])
      && date.getUTCDate() === Number(match[3]);
  }
  if (format === 'date-time') {
    return !Number.isNaN(new Date(value).valueOf());
  }

  return false;
}

/**
 * Показывает серверную дату в локальном времени поля datetime-local.
 * Неразбираемая строка сохраняется для прежней обработки ошибки формы.
 */
function dateTimeInputValue(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.valueOf())) {
    return value;
  }

  const local = new Date(date.valueOf() - date.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
}

/**
 * Возвращает введённое значение с прежним преобразованием времени в ISO.
 * Остальные типы передаются исполнителю без строкового приведения.
 */
function answerValue(question: ChatQuestionItem, value: QuestionValue | undefined) {
  if (question?.format !== 'date-time' || typeof value !== 'string') {
    return value;
  }

  const date = new Date(value);

  return Number.isNaN(date.valueOf()) ? value : date.toISOString();
}

/**
 * Собирает подсказку из объявленных ограничений вопроса.
 * Отсутствующие границы не добавляют выдуманных требований к ответу.
 */
function constraintText(question: ChatQuestionItem) {
  const parts = [];

  if (question?.minLength !== undefined) {
    parts.push(t('core.chatMinimumMinlengthSimv', { minLength: question.minLength }));
  }
  if (question?.maxLength !== undefined) {
    parts.push(t('core.chatMaksimumMaxlengthSimv', { maxLength: question.maxLength }));
  }
  if (question?.minimum !== undefined) {
    parts.push(t('core.chatNeMensheMinimum', { minimum: question.minimum }));
  }
  if (question?.maximum !== undefined) {
    parts.push(t('core.chatNeBolsheMaximum', { maximum: question.maximum }));
  }
  if (question?.minItems !== undefined) {
    parts.push(t('core.chatVybratMinimumMinitems', { minItems: question.minItems }));
  }
  if (question?.maxItems !== undefined) {
    parts.push(t('core.chatVybratMaksimumMaxitems', { maxItems: question.maxItems }));
  }

  return parts.join(' · ');
}

function hasAction(action: string) {
  return actions.value.some((entry) => entry.action === action);
}

function actionLabel(action: string) {
  if (action === 'accept' && !questions.value.length) {
    return t('core.allow');
  }

  return actions.value.find((entry) => entry.action === action)?.label || ACTION_LABELS[action];
}

function pickedValue(questionIndex: number) {
  const picked = state.value[questionIndex]?.picked || [];

  return questions.value[questionIndex]?.multiSelect
    ? picked
    : (picked[0] ?? null);
}

/**
 * UiChoiceList использует scalar в single-режиме и массив в multiple.
 * Внутреннее состояние хранит единый массив, чтобы payload ответа оставался прежним.
 */
function setPicked(questionIndex: number, value: unknown) {
  const item = state.value[questionIndex];

  if (!item) {
    return;
  }

  const selected = Array.isArray(value)
    ? value
    : (value == null ? [] : [value]);

  item.picked = selected.map((entry) => String(entry));
}

function setOwnField(questionIndex: number, field: unknown) {
  if (field) {
    ownFields.set(questionIndex, field as { focus(): void });
  } else {
    ownFields.delete(questionIndex);
  }
}

/**
 * Открытое поле сразу получает фокус, чтобы можно было начать писать с клавиатуры.
 * Браузер прокручивает его внутри карточки после появления в DOM.
 */
async function toggleOwn(questionIndex: number) {
  const item = state.value[questionIndex];

  if (!item) {
    return;
  }

  item.own = !item.own;

  if (item.own) {
    await nextTick();
    ownFields.get(questionIndex)?.focus();
  }
}

/**
 * Ответ сохраняет server contract: один объект на вопрос, выбранные подписи
 * остаются массивом, а свободный текст обрезается только по краям.
 */
function submit() {
  if (!ready.value) {
    return;
  }

  emit(
    'answer',
    questions.value.map((question, index) => ({
      header: question.header || '',
      question: question.question || '',
      selected: state.value[index]?.picked || [],
      text: (state.value[index]?.text || '').trim(),
    })),
  );
}

/**
 * Отправляет явный исход MCP отдельно от типизированных значений.
 * Необязательные пустые поля не добавляются в список ответов.
 */
function submitStructured(action: string) {
  const accepts = action.startsWith('accept');

  if (accepts && !ready.value) {
    return;
  }

  const answers = accepts
    ? questions.value.flatMap((question, index) => {
      const value = state.value[index]?.value;
      const emptyOptional = !question.required
        && (value === '' || (Array.isArray(value) && !value.length));

      return hasStructuredValue(question, value) && !emptyOptional
        ? [{ key: question.key, value: answerValue(question, value) }]
        : [];
    })
    : [];

  emit('answer', { action, answers });
}
</script>

<style scoped>
.q-item + .q-item {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.q-topic {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
  color: var(--ink-mid);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.q-number {
  display: grid;
  flex: none;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: 10px;
}

.q-text {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  margin-bottom: 10px;
  color: var(--ink);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.q-intro {
  margin-bottom: 14px;
}

.q-prompt {
  color: var(--ink);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.q-required {
  color: var(--bad);
  font-size: 11px;
  font-weight: 400;
}

.q-multi {
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 400;
}

.q-hint,
.q-rule {
  margin: 6px 0 10px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.q-own-toggle {
  margin-top: 6px;
}

.q-own {
  margin-top: 6px;
}

.q-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
}

.q-progress {
  color: var(--ink-mid);
  font-size: 11px;
}

.q-act {
  margin-left: auto;
}
</style>
