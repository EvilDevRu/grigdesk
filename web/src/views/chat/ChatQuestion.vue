<template>
  <div class="q">
    <div class="col">
      <div
        v-for="(question, questionIndex) in questions"
        :key="questionIndex"
        class="q-item"
      >
        <div class="q-text">
          <span class="q-ico">?</span>
          {{ question.question }}
          <span v-if="question.multiSelect" class="q-multi">можно несколько</span>
        </div>

        <div v-if="question.hint" class="q-hint">{{ question.hint }}</div>

        <UiChoiceList
          class="q-opts"
          :label="question.header || question.question"
          :mode="question.multiSelect ? 'multiple' : 'single'"
          :model-value="pickedValue(questionIndex)"
          :options="optionsOf(question)"
          @update:model-value="setPicked(questionIndex, $event)"
        />

        <UiButton
          v-if="freeText(question)"
          class="q-own-toggle"
          variant="text"
          tone="neutral"
          :pressed="state[questionIndex].own"
          block
          @click="toggleOwn(questionIndex)"
        >
          свой ответ…
        </UiButton>

        <UiInput
          v-if="freeText(question) && state[questionIndex].own"
          v-model="state[questionIndex].text"
          class="q-own"
          placeholder="напиши своими словами"
          @keydown.enter.prevent="ready && submit()"
        />
      </div>

      <UiFormActions class="q-act" align="start">
        <UiButton
          variant="solid"
          tone="accent"
          :disabled="!ready"
          @click="submit"
        >
          Ответить
        </UiButton>
        <UiButton @click="emit('skip')">Пропустить</UiButton>
      </UiFormActions>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import {
  UiButton,
  UiChoiceList,
  UiFormActions,
  UiInput,
} from '../../ui';

// Диалог агента: он спросил по существу, а не запросил разрешение на действие.
const props = defineProps({
  req: {
    type: Object,
    required: true,
  },
});
const emit = defineEmits(['answer', 'skip']);

const state = ref([]);

watch(
  () => props.req?.pid,
  () => {
    state.value = (props.req?.questions || []).map(() => ({
      picked: [],
      text: '',
      own: false,
    }));
  },
  { immediate: true },
);

const questions = computed(() => props.req?.questions || []);
const ready = computed(() => (
  state.value.some((item) => item.picked.length || item.text.trim())
));

function freeText(question) {
  return question?.allowFreeText !== false;
}

function optionsOf(question) {
  return (question?.options || []).map((option) => ({
    value: String(option.label || ''),
    label: String(option.label || ''),
    description: option.description ? String(option.description) : undefined,
  }));
}

function pickedValue(questionIndex) {
  const picked = state.value[questionIndex]?.picked || [];

  return questions.value[questionIndex]?.multiSelect
    ? picked
    : (picked[0] ?? null);
}

/**
 * UiChoiceList использует scalar в single-режиме и массив в multiple.
 * Внутреннее состояние хранит единый массив, чтобы payload ответа оставался прежним.
 */
function setPicked(questionIndex, value) {
  const item = state.value[questionIndex];

  if (!item) {
    return;
  }

  const selected = Array.isArray(value)
    ? value
    : (value == null ? [] : [value]);
  item.picked = selected.map((entry) => String(entry));
}

function toggleOwn(questionIndex) {
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
</script>

<style scoped>
/* Плашка живёт над композером и скроллится сама, если вопросов много. */
.q { padding: 9px 22px 10px; border-top: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line));
  background: color-mix(in srgb, var(--accent) 7%, transparent); max-height: 38vh; overflow-y: auto; }
.col { width: 100%; min-width: 0; }
.q-item + .q-item { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line); }
.q-text { display: flex; align-items: baseline; gap: 6px; margin-bottom: 7px; font-size: 13px; }
.q-ico { flex: none; color: var(--accent); font-weight: 700; }
.q-multi { padding: 0 5px; border: 1px solid var(--line); border-radius: 5px;
  color: var(--ink-mid); font-size: 10.5px; }
.q-hint { margin: -3px 0 7px 18px; color: var(--ink-mid); font-size: 11px; line-height: 1.45; }
.q-own-toggle { margin-top: 3px; }
.q-own { margin-top: 5px; }
.q-act { margin-top: 9px; }
</style>
