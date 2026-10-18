<template>
  <UiCard class="wait-card" :data-kind="item.kind">
    <template v-if="item.kind === 'unsupported'">
      <h2>Нужно решение в GrigDesk</h2>
      <p>{{ item.reason }}</p>
    </template>
    <template v-else-if="item.kind === 'permission'">
      <h2>{{ item.tool }}: запрос разрешения</h2>
      <p>{{ item.summary }}</p>
      <pre class="mobile-plan-text">{{ details || item.details }}</pre>
      <UiButton v-if="hasMore" :busy="busy" @click="readMore">Читать дальше</UiButton>
      <UiField
        v-if="item.acceptsComment"
        v-model="comment"
        label="Комментарий"
        multiline
        :max-length="4000"
      />
      <div class="mobile-actions">
        <UiButton
          kind="primary"
          :disabled="!readComplete || !item.actionToken"
          :busy="busy"
          @click="confirming = 'allow'"
          >Разрешить</UiButton
        >
        <UiButton
          kind="danger"
          :disabled="!item.actionToken"
          :busy="busy"
          @click="confirming = 'deny'"
        >
          Отклонить
        </UiButton>
      </div>
      <p v-if="!readComplete" class="mobile-muted">Прочитайте действие полностью перед ответом.</p>
    </template>
    <template v-else>
      <h2>Агент ждёт ответа</h2>
      <p class="mobile-prose">{{ item.prompt }}</p>
      <fieldset v-for="question in item.questions" :key="question.id" class="mobile-question">
        <legend>{{ question.header || question.question }}</legend>
        <p v-if="question.header">{{ question.question }}</p>
        <div class="mobile-options">
          <UiButton
            v-for="option in question.options"
            :key="option.id"
            :aria-pressed="drafts[question.id]?.optionIds.includes(option.id)"
            @click="toggle(question, option.id)"
          >
            <span
              ><strong>{{ option.label }}</strong
              ><span class="mobile-option-description"> {{ option.description }}</span></span
            >
          </UiButton>
        </div>
        <UiField
          v-if="
            !['number', 'integer', 'boolean'].includes(question.inputType) &&
            (question.allowFreeText || (question.inputType === 'text' && !question.options.length))
          "
          v-model="drafts[question.id]!.text"
          label="Ваш ответ"
          multiline
          :max-length="question.constraints.maxLength || 4000"
        />
        <UiField
          v-if="['number', 'integer'].includes(question.inputType)"
          v-model="drafts[question.id]!.value"
          label="Число"
          type="number"
        />
        <div v-if="question.inputType === 'boolean'" class="mobile-actions">
          <UiButton
            :aria-pressed="drafts[question.id]!.value === 'true'"
            @click="drafts[question.id]!.value = 'true'"
            >Да</UiButton
          >
          <UiButton
            :aria-pressed="drafts[question.id]!.value === 'false'"
            @click="drafts[question.id]!.value = 'false'"
            >Нет</UiButton
          >
        </div>
      </fieldset>
      <div class="mobile-actions">
        <UiButton
          v-for="action in item.actions"
          :key="action"
          :busy="busy"
          :kind="action === 'accept' ? 'primary' : 'default'"
          :disabled="!item.actionToken || (action === 'accept' && !validAnswers)"
          @click="answerQuestion(action)"
        >
          {{ action === 'accept' ? 'Ответить' : action === 'cancel' ? 'Отмена' : 'Отклонить' }}
        </UiButton>
      </div>
    </template>
    <UiError v-if="error" :text="error" />
    <p v-if="notice" role="status">{{ notice }}</p>
    <UiDialog
      v-if="confirming"
      :title="confirming === 'allow' ? 'Разрешить действие?' : 'Отклонить действие?'"
      :confirm="confirming === 'allow' ? 'Разрешить' : 'Отклонить'"
      :danger="confirming === 'deny'"
      :busy="busy"
      @close="confirming = ''"
      @confirm="answerPermission"
    >
      <p>{{ item.kind === 'permission' ? item.summary : '' }}</p>
      <p v-if="comment" class="mobile-prose">{{ comment }}</p>
    </UiDialog>
  </UiCard>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';

import type {
  Permission,
  Question,
  QuestionWaiting,
  UnsupportedWaiting,
  WaitingAnswer,
} from '../api/contract.ts';
import { questionAnswer, type QuestionDraft } from '../api/questions.ts';
import { ApiError } from '../api/client.ts';
import { UiButton, UiCard, UiDialog, UiError, UiField } from '../ui.ts';
import { useLinkStore } from '../stores/link.ts';

const props = defineProps<{ item: Permission | QuestionWaiting | UnsupportedWaiting }>();
const emit = defineEmits<{ answered: [] }>();
const link = useLinkStore();
const details = ref('');
const revision = ref('');
const offset = ref<number | undefined>(undefined);
const hasMore = ref(true);
const readComplete = ref(false);
const comment = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);
const confirming = ref<'' | 'allow' | 'deny'>('');
const drafts = reactive<Record<string, QuestionDraft>>({});
let epoch = 0;
const answers = computed(() =>
  props.item.kind === 'question'
    ? props.item.questions.map((question) =>
        questionAnswer(
          question,
          drafts[question.id] || {
            optionIds: [],
            text: '',
            value: '',
          },
        ),
      )
    : [],
);
const validAnswers = computed(() => answers.value.every(Boolean));

/**
 * Новый запрос сбрасывает прочитанный план и выбранные ответы старого разрешения.
 * ActionToken никогда не переносится на другой pid или версию содержания.
 */
function reset() {
  epoch += 1;
  busy.value = false;
  comment.value = '';
  notice.value = '';
  error.value = '';
  details.value = '';
  revision.value = '';
  offset.value = undefined;
  readComplete.value = false;
  hasMore.value = true;
  confirming.value = '';

  for (const key of Object.keys(drafts)) {
    delete drafts[key];
  }

  if (props.item.kind === 'question') {
    for (const question of props.item.questions) {
      drafts[question.id] = {
        optionIds: [],
        text: '',
        value: '',
      };
    }
  }
}

/**
 * Каждая страница сверяет revision; кнопка разрешения появляется после последней страницы.
 * Ошибка обновлённого плана требует нового чтения, а не использования прежнего read proof.
 */
async function readMore() {
  if (props.item.kind !== 'permission' || busy.value) {
    return;
  }

  const pid = props.item.pid;
  const token = props.item.actionToken;
  const captured = epoch;

  busy.value = true;
  error.value = '';

  try {
    const page = await link.api!.getWaitingDetails(pid, offset.value, revision.value || undefined);

    if (
      captured !== epoch ||
      props.item.pid !== pid ||
      props.item.kind !== 'permission' ||
      props.item.actionToken !== token
    ) {
      return;
    }

    details.value += page.text;
    revision.value = page.contentRevision;
    offset.value = page.nextOffset ?? undefined;
    hasMore.value = page.hasMore;
    readComplete.value = !page.hasMore && Boolean(page.readToken);
  } catch (failure) {
    if (captured !== epoch) {
      return;
    }

    error.value = failure instanceof Error ? failure.message : 'Действие недоступно.';

    if (failure instanceof ApiError && failure.status === 409) {
      reset();
      emit('answered');
    }
  } finally {
    if (captured === epoch) {
      busy.value = false;
    }
  }
}

/**
 * Выбор хранит только id варианта; label никогда не заменяет идентичность ответа.
 * Одиночный и множественный выбор используют один обработчик с разным cardinality.
 */
function toggle(question: Question, id: string) {
  const draft = drafts[question.id]!;

  draft.optionIds = draft.optionIds.includes(id)
    ? draft.optionIds.filter((value) => value !== id)
    : question.multiSelect
      ? [...draft.optionIds, id]
      : [id];
}

/**
 * Ответ отправляет только актуальный actionToken и показывает непереданный каналом комментарий.
 * Конфликт перечитывает запрос; автоматическое повторное решение запрещено.
 */
async function send(body: WaitingAnswer) {
  const captured = epoch;

  busy.value = true;
  error.value = '';

  try {
    const result = await link.api!.answerWaiting(props.item.pid, body);

    if (captured !== epoch) {
      return;
    }

    if (result.commentDelivered === false || result.textDelivered === false) {
      notice.value = 'Ответ принят. Комментарий или свободный текст не передан этим каналом.';
    } else {
      emit('answered');
    }
  } catch (failure) {
    if (captured !== epoch) {
      return;
    }

    error.value =
      failure instanceof ApiError && failure.code === 'state_changed'
        ? 'Уже решено в другом окне.'
        : failure instanceof Error
          ? failure.message
          : 'Ответ не отправлен.';

    if (failure instanceof ApiError && failure.status === 409) {
      emit('answered');
    }
  } finally {
    if (captured === epoch) {
      busy.value = false;
      confirming.value = '';
    }
  }
}

const answerPermission = () =>
  props.item.kind === 'permission' &&
  send({
    decision: confirming.value as 'allow' | 'deny',
    comment: comment.value,
    actionToken: props.item.actionToken!,
  });
const answerQuestion = (action: 'accept' | 'cancel' | 'decline') =>
  props.item.kind === 'question' &&
  send({
    action,
    actionToken: props.item.actionToken!,
    answers: action === 'accept' ? answers.value.filter((answer) => answer !== null) : undefined,
  });

watch(
  () =>
    `${props.item.kind}:${props.item.pid}:${'actionToken' in props.item ? props.item.actionToken : ''}`,
  () => {
    reset();
    void readMore();
  },
  { immediate: true },
);
</script>
