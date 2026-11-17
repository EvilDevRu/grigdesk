<template>
  <div class="source" data-testid="showcase-source">
    <p class="source__intro">{{ t('core.showcaseIstochnikRasskazaZadachaI') }}</p>

    <UiInlineMessage v-if="externalChange" tone="warning" data-role="source-external">
      {{ t('core.showcaseSohranennyyVyborIzmenilsyaPoka') }}
      <UiButton variant="ghost" :disabled="busy" @click="resetDraft">
        {{ t('core.showcaseVernutSohranennyy') }}
      </UiButton>
    </UiInlineMessage>

    <div class="source__fields">
      <UiField :label="t('core.showcaseNomerZadachiB24')" :hint="t('core.showcaseNomerZadachiNeobyazatelen')">
        <UiInput
          v-model="taskId"
          inputmode="numeric"
          :maxlength="12"
          :disabled="busy"
          data-testid="showcase-source-task"
          @blur="loadTitle"
        />
      </UiField>
      <p v-if="taskTitle" class="source__hint" data-testid="showcase-source-task-title">
        {{ taskTitle }}
      </p>
      <UiInlineMessage v-if="taskError" tone="warning">{{ taskError }}</UiInlineMessage>
      <UiField :label="t('core.showcaseSvoimiSlovami')" :hint="t('core.showcaseChtoPokazatINa')">
        <UiTextarea
          v-model="note"
          rows="3"
          :maxlength="noteMax"
          :disabled="busy"
          data-testid="showcase-source-note"
        />
      </UiField>
    </div>

    <div class="source__actions">
      <UiButton
        variant="outline"
        :disabled="busy"
        data-testid="showcase-source-apply"
        @click="apply"
      > {{ t('core.showcasePrimenitVybor') }} </UiButton>
    </div>
  </div>
</template>

<script setup lang="ts">
// Источник рассказа: опциональная задача Б24 и комментарий. Номер — данные человека;
// заголовок добирает стор задач, текст для модели прочитает сервер при разборе.
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { SHOWCASE_SOURCE_NOTE_MAX } from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import type {
  ShowcaseProject,
  ShowcaseStorySource,
} from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import { UiButton, UiField, UiInlineMessage, UiInput, UiTextarea, t } from '../../ui';
import { useTasksStore } from '../../stores/tasks';

const props = defineProps<{
  project: ShowcaseProject;
  busy: boolean;
}>();

const emit = defineEmits<{
  apply: [source: ShowcaseStorySource | null];
}>();

const noteMax = SHOWCASE_SOURCE_NOTE_MAX;
const tasks = useTasksStore();
const taskId = ref(props.project.source?.taskId ?? '');
const note = ref(props.project.source?.note ?? '');
const taskTitle = ref('');
const taskError = ref('');
const savedJson = computed(() => JSON.stringify(props.project.source ?? null));
const draftSource = computed<ShowcaseStorySource | null>(() => {
  const id = taskId.value.trim();
  const text = note.value.trim();

  return id || text ? { taskId: id || null, note: text } : null;
});
const draftJson = computed(() => JSON.stringify(draftSource.value));
const externalChange = ref(false);
let titleRequest = 0;

// Подпись относится к текущему вводу: смена номера сразу снимает старую подпись.
watch(taskId, () => {
  titleRequest += 1;
  taskTitle.value = '';
  taskError.value = '';
}, { flush: 'sync' });

onBeforeUnmount(() => {
  titleRequest += 1;
});

// Чужая правка источника не затирает набранное: черновик помечается, человек решает.
watch(savedJson, () => {
  externalChange.value = draftJson.value !== savedJson.value;
});

watch(() => props.project.id, () => {
  resetDraft();
});

/**
 * Новый ролик получает свой сохранённый источник без черновика предыдущего.
 * Возврат сохранённого остаётся явным решением человека.
 */
function resetDraft() {
  taskId.value = props.project.source?.taskId ?? '';
  note.value = props.project.source?.note ?? '';
  taskTitle.value = '';
  taskError.value = '';
  externalChange.value = false;
  void loadTitle();
}

/**
 * Заголовок добирает общий стор задач, номер остаётся данными человека.
 * Негодный номер не инициирует запрос к порталу.
 */
async function loadTitle() {
  const id = taskId.value.trim();
  const projectId = props.project.id;
  const request = ++titleRequest;
  const current = () => request === titleRequest
    && props.project.id === projectId && taskId.value.trim() === id;

  taskTitle.value = '';
  taskError.value = '';

  if (!/^\d{1,12}$/u.test(id)) {
    return;
  }

  try {
    await tasks.load(id);

    if (current()) {
      taskTitle.value = tasks.title(id) ?? '';
    }
  } catch {
    if (current()) {
      taskError.value = t('core.showcaseZadachuNeUdalosProchitat');
    }
  }
}

function apply() {
  emit('apply', draftSource.value);
}

void loadTitle();
</script>

<style scoped>
.source__fields {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.source__actions {
  margin-top: 0.75rem;
}

.source__hint {
  color: var(--ui-text-muted);
  font-size: 0.85rem;
}
</style>
