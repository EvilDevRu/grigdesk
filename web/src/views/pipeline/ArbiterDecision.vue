<template>
  <UiDialog
    :open="open"
    class="arbdlg"
    data-role="pipeline-arbiter-decision"
    size="content"
    :label="`Разбор арбитра — ${label}`"
    @update:open="onOpenChange"
  >
    <template #header>
      <div class="ad-head">
        <span class="ad-kicker">{{ kicker }}</span>
        <h3 class="ad-title">{{ label }}</h3>
      </div>
      <span v-if="card?.model" class="ad-model mono">{{ card.model }}</span>
      <UiIconButton
        class="ad-x"
        data-context="pipeline-arbiter-close"
        label="Закрыть разбор"
        v-tooltip="'Закрыть (Esc)'"
        @click="emit('close')"
      >
        ✕
      </UiIconButton>
    </template>

    <!-- Разбор целиком: это единственный текст остановки, написанный ДЛЯ ЧЕЛОВЕКА, тогда
         как причина движка и находки узла — машинные формулировки. Ради него модалка и
         отдельная: в узле он делил колонку с телеметрией, вердиктом и формой. -->
    <p class="ad-what">{{ card?.card?.what }}</p>
    <section v-for="part in parts" :key="part.key" class="ad-part">
      <h4 class="ad-plbl">{{ part.label }}</h4>
      <!-- Метка стоит НАД текстом, а не слева от него: в двухколоночной паре тексту
           оставалась половина ширины, и длинный путь из «чем проверял» выдавливал
           колонку в горизонтальный скролл. -->
      <p class="ad-ptext">{{ part.text }}</p>
    </section>

    <div class="ad-form">
      <h4 class="ad-fh">Твоё решение</h4>
      <!-- Вопросы узла — своими полями: агент вернул их структурно, и ответ должен быть
           привязан к тому вопросу, который его вызвал. -->
      <div v-if="questions.length" class="ad-q">
        <div v-for="(question, index) in questions" :key="question.id" class="ad-qitem">
          <label class="ad-qlbl" :for="`ad-q-${index}`">
            <span class="ad-qnum">{{ index + 1 }}</span>
            <span class="ad-qsum">
              {{ question.summary }}
              <span v-if="question.anchor" class="ad-anchor mono" v-tooltip="question.anchor">{{
                shortAnchor(question.anchor)
              }}</span>
            </span>
          </label>
          <UiTextarea
            :id="`ad-q-${index}`"
            v-model="answers[question.id]"
            data-role="pipeline-arbiter-answer"
            rows="2"
            placeholder="Ответ на этот вопрос"
          />
        </div>
      </div>
      <label class="ad-flbl" for="ad-free">{{
        questions.length ? 'Что ещё сказать агенту' : 'Решение и указание агенту'
      }}</label>
      <UiTextarea
        id="ad-free"
        v-model="free"
        data-role="pipeline-arbiter-answer"
        :rows="questions.length ? 4 : 7"
        :placeholder="questions.length
          ? 'Необязательно: остальное по задаче'
          : 'Что выбрать и почему — этот текст движок подмешает в промпт захода'"
      />
    </div>

    <template #footer>
      <span class="ad-note">Узел и всё, что за ним, будет переигран.</span>
      <UiButton variant="text" tone="neutral" @click="emit('close')">
        Отмена
      </UiButton>
      <UiButton
        class="ad-send"
        data-role="pipeline-arbiter-send"
        tone="warning"
        variant="outline"
        :loading="busy"
        :disabled="busy || !filled"
        loading-label="Возвращаю конвейер"
        @click="submit"
      >
        ▶ Отправить решение и продолжить
      </UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PropType } from 'vue';

import { UiButton, UiDialog, UiIconButton, UiTextarea, vTooltip } from '../../ui';
import { buildRewindNote } from '../../shared/rewindNote.ts';

interface ArbiterDecisionView {
  node?: string;
  label?: string;
  questions?: NonNullable<Parameters<typeof buildRewindNote>[0]>;
  card?: {
    verdict?: string;
    model?: string;
    card?: {
      what?: string;
      why?: string;
      proof?: string;
      risk?: string;
    };
  } | null;
}

// Разбор арбитра и ответ на него. Отдельная модалка, потому что узел отвечает на другой
// вопрос («чем занят исполнитель и чем кончился заход»), а здесь человек читает четыре
// абзаца и пишет решение — вместе они не помещались, и разбор приходилось искать среди
// телеметрии, вердикта и попыток запуска.
const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  decision: {
    type: Object as PropType<ArbiterDecisionView | null>,
    default: null,
  },
  busy: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits<{
  close: [];
  submit: [note: string];
}>();

const PARTS = [
  ['why', 'Почему'],
  ['proof', 'Чем проверял'],
  ['risk', 'Чем грозит ошибка'],
] as const;

const answers = ref<Record<string, string>>({});
const free = ref('');

const card = computed(() => props.decision?.card || null);
const label = computed(() => props.decision?.label || 'узел');
const questions = computed(() => props.decision?.questions || []);
const kicker = computed(() => (
  card.value?.verdict === 'human' ? 'Арбитр разобрал: решать тебе' : 'Разбор арбитра'
));

// Показываем только то, что арбитр действительно написал: пустая графа означает «он об
// этом не говорил», и заголовок без текста читался бы как потерянный ответ.
const parts = computed(() => PARTS
  .map(([key, partLabel]) => ({
    key,
    label: partLabel,
    text: card.value?.card?.[key] || '',
  }))
  .filter((part) => part.text));

const note = computed(() => buildRewindNote(questions.value, answers.value, free.value));
const filled = computed(() => Boolean(note.value.trim()));

// Открытие другого узла обязано начинать с чистого листа: текст, набранный для прошлой
// остановки, уехал бы указанием совсем другому агенту.
watch(() => [props.open, props.decision?.node], () => {
  answers.value = {};
  free.value = '';
});

function onOpenChange(value: boolean) {
  if (!value) {
    emit('close');
  }
}

function submit() {
  if (!filled.value) {
    return;
  }

  emit('submit', note.value);
}

/**
 * Оставляет в строке вопроса только хвост якоря, чтобы путь не съедал формулировку.
 * Полный адрес по-прежнему доступен в подсказке исходного поля.
 */
function shortAnchor(anchor: unknown) {
  const text = String(anchor || '');
  const segments = text.split('/');

  return segments.length > 1 ? segments[segments.length - 1] : text;
}
</script>

<style scoped>
.ad-head { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ad-kicker { color: var(--warn); font-size: 10.5px; text-transform: uppercase; letter-spacing: .055em; }
.ad-title { margin: 0; font-size: 15px; font-weight: 600; }
.ad-model { margin-left: auto; color: var(--ink-mid); font-size: 10.5px; opacity: .8; }
.ad-x { flex: none; }

/* Текст арбитра — то, ради чего модалку открывают, поэтому он идёт первым и во всю
   ширину. Длинные пути и хеши переносятся принудительно: неразрывный токен в «чем
   проверял» иначе растягивает диалог и включает горизонтальный скролл. */
.ad-what { margin: 0 0 14px; font-size: 14px; font-weight: 550; line-height: 1.5;
  color: var(--ink); overflow-wrap: anywhere; }
.ad-part { margin-bottom: 10px; }
.ad-plbl { margin: 0 0 2px; color: var(--ink-mid); font-size: 10.5px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .055em; }
.ad-ptext { margin: 0; font-size: 13px; line-height: 1.55; color: var(--ink);
  overflow-wrap: anywhere; }

.ad-form { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
.ad-fh { margin: 0 0 8px; color: var(--warn); font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .06em; }
.ad-q { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.ad-qitem { display: flex; flex-direction: column; gap: 4px; }
.ad-qlbl { display: flex; align-items: baseline; gap: 6px; font-size: 12.5px; }
.ad-qnum { flex: none; min-width: 16px; height: 16px; display: inline-flex; align-items: center;
  justify-content: center; border-radius: 5px; background: color-mix(in srgb, var(--warn) 18%, transparent);
  color: var(--warn); font-size: 10.5px; font-weight: 600; }
.ad-qsum { min-width: 0; overflow-wrap: anywhere; }
.ad-anchor { margin-left: 6px; color: var(--ink-mid); font-size: 11px; opacity: .85; }
.ad-flbl { display: block; margin-bottom: 4px; color: var(--ink-mid); font-size: 11.5px; }

.ad-note { flex: 1; min-width: 0; color: var(--ink-mid); font-size: 11.5px; }

@media (max-width: 620px) {
  .ad-note { flex-basis: 100%; }
}
</style>
