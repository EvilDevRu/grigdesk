<template>
  <section class="pane">
    <UiPaneHeader
      :title="current?.task.title || listed?.title || 'Задача'"
      :sub="current ? stateName(current.task.state) : ''"
      back="/tasks"
      back-label="Все задачи конвейера"
    />
    <div ref="body" class="pane-body">
      <div class="pane-content">
        <UiError
          v-if="store.detailError || error"
          :text="store.detailError || error"
          @retry="reload"
        />
        <p v-if="!current && !store.detailError && !error" class="list-loading" role="status">
          Загрузка…
        </p>
        <template v-if="current">
          <div class="detail-heading">
            <span class="row-id">Задача #{{ current.task.id }}</span>
            <h2>{{ current.task.title }}</h2>
          </div>
          <section class="detail-now" :data-wait="current.task.needsHuman ? 'true' : undefined">
            <span class="section-title">
              {{ current.task.needsHuman ? 'Нужно решение' : 'Сейчас' }}
            </span>
            <p>{{ current.task.needsHuman?.text || current.task.stage }}</p>
            <div
              v-if="current.task.actions.resume || current.task.actions.stop"
              class="mobile-actions"
            >
              <UiButton v-if="current.task.actions.resume" @click="ask('resume')">
                Продолжить
              </UiButton>
              <UiButton v-if="current.task.actions.stop" kind="danger" @click="ask('stop')">
                Остановить
              </UiButton>
            </div>
          </section>
          <section class="detail-section">
            <h2 class="section-title">Этапы</h2>
            <ol class="mobile-stages">
              <li
                v-for="stage in current.task.stages"
                :key="stage.key"
                :data-status="stage.status"
              >
                <span class="stage-dot" aria-hidden="true"></span>
                <span class="stage-title">{{ stage.title }}</span>
                <UiChip :tone="stageTone(stage.status)">{{ stageName(stage.status) }}</UiChip>
              </li>
            </ol>
          </section>
          <section class="detail-section">
            <pre v-if="plan" class="mobile-plan-text">{{ plan }}</pre>
            <UiButton v-if="!readComplete" :busy="reading" @click="readPlan">
              {{ plan ? 'Читать дальше' : 'План' }}
            </UiButton>
            <p v-if="notice" role="status">{{ notice }}</p>
          </section>
          <section v-if="current.task.needsHuman?.kind === 'gate'" class="detail-section">
            <h2 class="section-title">Решение по воротам</h2>
            <p v-if="!readComplete" class="mobile-muted">
              Прочитайте основание полностью перед решением.
            </p>
            <div class="mobile-actions">
              <UiButton
                kind="primary"
                variant="solid"
                :disabled="!readComplete"
                @click="ask('approve')"
              >
                Принять
              </UiButton>
              <UiButton kind="danger" :disabled="!readComplete" @click="ask('reject')">
                Отклонить
              </UiButton>
            </div>
          </section>
        </template>
      </div>
    </div>
    <UiDialog
      v-if="selected"
      :title="dialogTitle"
      :confirm="confirmLabel"
      :danger="['reject', 'stop'].includes(selected.kind)"
      :busy="busy"
      @close="selected = null"
      @confirm="commit"
    >
      <p>{{ current?.task.title }}</p>
      <UiField
        v-if="['approve', 'reject'].includes(selected.kind)"
        v-model="comment"
        label="Комментарий"
        multiline
        :max-length="4000"
      />
      <p>Решение относится к показанному запуску задачи.</p>
    </UiDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { UiButton, UiChip, UiDialog, UiError, UiField, UiPaneHeader } from '../ui.ts';
import { stageName, stageTone, stateName } from '../ui/taskState.ts';
import { ApiError } from '../api/client.ts';
import { useTasksStore } from '../stores/tasks.ts';
import { useLinkStore } from '../stores/link.ts';
import { useReload } from '../composables/useReload.ts';

const route = useRoute();
const store = useTasksStore();
const link = useLinkStore();
const id = computed(() => String(route.params.id));
const current = computed(() => (store.current?.task.id === id.value ? store.current : null));
const listed = computed(() => store.list?.tasks.find((task) => task.id === id.value) || null);
const body = ref<HTMLElement | null>(null);
const error = ref('');
const notice = ref('');
const comment = ref('');
const busy = ref(false);
const reading = ref(false);
const plan = ref('');
const revision = ref('');
const offset = ref<number | undefined>(undefined);
const readComplete = ref(false);
const selected = ref<{
  kind: 'approve' | 'reject' | 'resume' | 'stop';
  token: string;
  gate: string;
  id: string;
} | null>(null);
const labels: Record<string, string> = {
  approve: 'Принять ворота?',
  reject: 'Отклонить ворота?',
  resume: 'Продолжить задачу?',
  stop: 'Остановить задачу?',
};
const dialogTitle = computed(() => labels[selected.value?.kind || ''] || 'Подтвердить решение');
const confirmLabel = computed(() => selected.value ? ({
  approve: 'Принять',
  reject: 'Отклонить',
  resume: 'Продолжить',
  stop: 'Остановить',
})[selected.value.kind] : 'Подтвердить');
const reload = () => store.load(id.value);

/**
 * Последовательные страницы связаны revision; новое основание сбрасывает прежний read proof.
 * Текст отображается целиком через pre-wrap, без HTML и без скрытого сокращения.
 */
async function readPlan() {
  if (reading.value || readComplete.value) {
    return;
  }

  const capturedId = id.value;
  const generation = link.state?.generation;

  reading.value = true;
  error.value = '';

  try {
    const page = await link.api!.getPlan(capturedId, offset.value, revision.value || undefined);

    if (capturedId !== id.value || generation !== link.state?.generation) {
      return;
    }

    plan.value += page.text;
    revision.value = page.contentRevision;
    offset.value = page.nextOffset ?? undefined;
    readComplete.value = !page.hasMore && Boolean(page.readToken);
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'План недоступен.';

    if (failure instanceof ApiError && failure.status === 409) {
      plan.value = '';
      offset.value = undefined;
      revision.value = '';
      readComplete.value = false;
      await reload();
    }
  } finally {
    reading.value = false;
  }
}

/**
 * Подтверждение хранит токен с момента нажатия; live refresh не подменяет его новым действием.
 * Отсутствие gate/read proof не даёт открыть диалог для решения.
 */
function ask(kind: 'approve' | 'reject' | 'resume' | 'stop') {
  const task = current.value?.task;
  const gate = task?.needsHuman;
  const token = ['approve', 'reject'].includes(kind) ? gate?.actionToken : task?.actions[kind];

  if (!token || (['approve', 'reject'].includes(kind) && !readComplete.value)) {
    return;
  }

  comment.value = '';
  selected.value = {
    kind,
    token,
    gate: gate?.gate || '',
    id: id.value,
  };
}

/**
 * CAS конфликт требует перечитывания и нового подтверждения, а partial success остаётся видимым.
 * Потеря ответа показывает неопределённый исход вместо автоматического повторения новой команды.
 */
async function commit() {
  const action = selected.value;

  if (!action || busy.value) {
    return;
  }

  busy.value = true;
  error.value = '';
  notice.value = '';

  try {
    if (action.kind === 'approve' || action.kind === 'reject') {
      const result = await link.api!.gateTask(action.id, {
        gate: action.gate,
        decision: action.kind,
        comment: comment.value,
        actionToken: action.token,
      });

      notice.value = result.resumed
        ? 'Решение принято.'
        : 'Решение принято, продолжение не запущено.';

      if (result.resumeError) {
        notice.value += ' ' + result.resumeError;
      }
    } else {
      await link.api!.taskAction(action.id, action.kind, action.token);
    }
  } catch (failure) {
    error.value =
      failure instanceof ApiError && failure.status === 409
        ? 'Уже решено в другом окне.'
        : failure instanceof Error
          ? failure.message
          : 'Результат решения не подтверждён.';
  } finally {
    selected.value = null;
    busy.value = false;
    readComplete.value = false;
    plan.value = '';
    revision.value = '';
    offset.value = undefined;
    await reload();
  }
}

watch(id, () => {
  // На планшете карточка не пересоздаётся при выборе другой задачи: читаем её с начала.
  if (body.value) {
    body.value.scrollTop = 0;
  }

  plan.value = '';
  revision.value = '';
  offset.value = undefined;
  readComplete.value = false;
  selected.value = null;
  notice.value = '';
  void reload();
});
useReload(reload, ['tasks']);
</script>
