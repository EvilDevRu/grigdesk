<template>
  <div class="q">
    <div class="col">
      <div v-if="structured && (source || prompt)" class="q-intro">
        <span v-if="source" class="q-source">{{ source }}</span>
        <div v-if="prompt" class="q-prompt">{{ prompt }}</div>
      </div>

      <div
        v-for="(question, questionIndex) in questions"
        :key="question.key || questionIndex"
        class="q-item"
      >
        <div class="q-text">
          <span class="q-ico">?</span>
          {{ question.question }}
          <span v-if="structured && question.required" class="q-required">обязательно</span>
          <span v-if="question.multiSelect" class="q-multi">можно несколько</span>
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
        </template>

        <template v-else>
        <UiChoiceList
          class="q-opts"
          :label="question.header || question.question"
          :mode="question.multiSelect ? 'multiple' : 'single'"
          :model-value="pickedValue(questionIndex)"
          :options="optionsOf(question)"
          selection-indicator
          @update:model-value="setPicked(questionIndex, $event)"
        />

        <UiButton
          v-if="freeText(question)"
          class="q-own-toggle"
          variant="text"
          tone="neutral"
          :pressed="state[questionIndex]!.own"
          block
          @click="toggleOwn(questionIndex)"
        >
          свой ответ…
        </UiButton>

        <UiInput
          v-if="freeText(question) && state[questionIndex]!.own"
          v-model="state[questionIndex]!.text"
          class="q-own"
          placeholder="напиши своими словами"
          @keydown.enter.prevent="ready && submit()"
        />
        </template>
      </div>

      <UiFormActions class="q-act" align="start">
        <template v-if="structured">
          <UiButton
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
            v-if="hasAction('decline')"
            tone="danger"
            @click="submitStructured('decline')"
          >
            {{ actionLabel('decline') }}
          </UiButton>
          <UiButton v-if="hasAction('cancel')" @click="submitStructured('cancel')">
            {{ actionLabel('cancel') }}
          </UiButton>
        </template>
        <template v-else>
          <UiButton
            variant="solid"
            tone="accent"
            :disabled="!ready"
            @click="submit"
          >
            Ответить
          </UiButton>
          <UiButton @click="emit('skip')">Пропустить</UiButton>
        </template>
      </UiFormActions>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PropType } from 'vue';
import type { ChatQuestion, ChatQuestionItem, QuestionValue } from '../../shared/chatContracts.ts';
import {
  UiButton,
  UiChoiceList,
  UiFormActions,
  UiInput,
  UiNumberInput,
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

watch(
  () => props.req?.pid,
  () => {
    state.value = (props.req?.questions || []).map((question) => ({
      picked: [],
      text: '',
      own: false,
      value: initialValue(question),
    }));
  },
  { immediate: true },
);

const questions = computed(() => props.req?.questions || []);
const structured = computed(() => props.req?.structured === true);
const source = computed(() => String(props.req?.source || ''));
const prompt = computed(() => String(props.req?.prompt || ''));
const ready = computed(() => (structured.value
  ? questions.value.every((question, index) => validStructured(question, state.value[index]?.value))
  : state.value.some((item) => item.picked.length || item.text.trim())));

const DEFAULT_ACTIONS = Object.freeze(['accept', 'cancel']);
const ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  accept: 'Отправить',
  accept_session: 'Разрешить на сессию',
  accept_always: 'Разрешать всегда',
  decline: 'Отклонить',
  cancel: 'Отменить',
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
  return ['choice', 'multi-choice', 'boolean'].includes(question?.inputType || '');
}

function structuredOptions(question: ChatQuestionItem) {
  if (question?.inputType === 'boolean') {
    return [
      { value: true, label: 'Да' },
      { value: false, label: 'Нет' },
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
  if (question?.inputType === 'text') {
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

  if (question?.inputType === 'text') {
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
    parts.push(`минимум ${question.minLength} симв.`);
  }
  if (question?.maxLength !== undefined) {
    parts.push(`максимум ${question.maxLength} симв.`);
  }
  if (question?.minimum !== undefined) {
    parts.push(`не меньше ${question.minimum}`);
  }
  if (question?.maximum !== undefined) {
    parts.push(`не больше ${question.maximum}`);
  }
  if (question?.minItems !== undefined) {
    parts.push(`выбрать минимум ${question.minItems}`);
  }
  if (question?.maxItems !== undefined) {
    parts.push(`выбрать максимум ${question.maxItems}`);
  }

  return parts.join(' · ');
}

function hasAction(action: string) {
  return actions.value.some((entry) => entry.action === action);
}

function actionLabel(action: string) {
  if (action === 'accept' && !questions.value.length) {
    return 'Разрешить';
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

function toggleOwn(questionIndex: number) {
  const item = state.value[questionIndex];

  if (item) {
    item.own = !item.own;
  }
}

/**
 * Ответ сохраняет server contract: один объект на вопрос, выбранные подписи
 * остаются массивом, а свободный текст обрезается только по краям.
 */
function submit() {
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
/* Плашка живёт над композером и скроллится сама, если вопросов много. */
.q { padding: 9px 22px 10px; border-top: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line));
  background: color-mix(in srgb, var(--accent) 7%, transparent); max-height: 38vh; overflow-y: auto; }
.col { width: 100%; min-width: 0; }
.q-item + .q-item { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line); }
.q-text {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  margin-bottom: 7px;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.q-ico { flex: none; color: var(--accent); font-weight: 700; }
.q-intro { margin-bottom: 10px; }
.q-source { color: var(--accent); font-size: 11px; font-weight: 650; }
.q-prompt { margin-top: 3px; color: var(--ink); font-size: 13px; line-height: 1.45;
  overflow-wrap: anywhere; }
.q-required { color: var(--bad); font-size: 10.5px; }
.q-multi { padding: 0 5px; border: 1px solid var(--line); border-radius: 5px;
  color: var(--ink-mid); font-size: 10.5px; }
.q-hint {
  margin: -3px 0 7px 18px;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.q-rule { margin: 5px 0 0 18px; color: var(--ink-mid); font-size: 10.5px; }
.q-own-toggle { margin-top: 3px; }
.q-own { margin-top: 5px; }
.q-act { margin-top: 9px; }
</style>
