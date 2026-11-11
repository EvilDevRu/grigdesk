<template>
  <UiDialog :open="open" :title="t('core.grigdeskNewTask')" :busy="saving"
            :description="t('core.grigdeskNewTaskIntro')" :dismissible="!saving"
            data-role="new-grigdesk-task" data-ui-workspace initial-focus="#grigdesk-task-title"
            @update:open="emit('update:open', $event)">
    <template #title>
      <div class="new-task-heading">
        <span class="new-task-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">
            <rect x="5" y="4" width="14" height="17" rx="2" />
            <path d="M9 3h6v3H9zM9 11h6M9 15h3" />
          </svg>
        </span>
        <span class="new-task-title">{{ t('core.grigdeskNewTask') }}</span>
        <UiIconButton :label="t('core.close')" :disabled="saving" @click="emit('update:open', false)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </UiIconButton>
      </div>
    </template>

    <form id="grigdesk-new-task" class="new-task-form" @submit.prevent="save">
      <UiField id="grigdesk-task-board" :label="t('core.newTaskBoard')" required>
        <UiSelect v-model="boardId" :disabled="saving || loadingBoards">
          <option value="own">GrigDesk</option>
          <option v-for="driver in externalBoards" :key="driver.id" :value="driver.id"
                  :disabled="driver.status !== 'active' || !driver.configured">
            {{ driver.name }}
          </option>
        </UiSelect>
      </UiField>
      <UiInlineMessage v-if="trackers.error" tone="warning">{{ trackers.error }}</UiInlineMessage>
      <UiField id="grigdesk-task-title" :label="t('core.grigdeskTaskTitle')" required>
        <UiInput v-model="title" :placeholder="t('core.grigdeskTaskTitlePlaceholder')"
                 :maxlength="500" :disabled="saving" />
      </UiField>
      <UiField v-if="needsProject" id="grigdesk-task-project" :label="t('core.grigdeskTaskProject')" required>
        <UiSelect v-model="projectId" :disabled="saving || loadingProjects">
          <option value="">{{ t('core.grigdeskChooseProject') }}</option>
          <option v-for="project in projects" :key="project.id" :value="project.id">
            {{ project.title }}
          </option>
        </UiSelect>
      </UiField>
      <UiInlineMessage v-if="needsProject && !loadingProjects && !projects.length">
        {{ t(boardId === 'own' ? 'core.grigdeskNoProjects' : 'core.newTaskNoProjects') }}
      </UiInlineMessage>
      <UiField :label="t('core.grigdeskTaskOptionalDescription')">
        <UiTextarea v-model="description" :placeholder="t('core.grigdeskTaskDescriptionPlaceholder')"
                    :maxlength="100000" :rows="5" :disabled="saving" />
      </UiField>
      <UiInlineMessage v-if="error" tone="danger">{{ error }}</UiInlineMessage>
    </form>

    <template #footer>
      <div class="new-task-footer">
        <p class="new-task-note">{{ t('core.grigdeskTaskCreationHint') }}</p>
        <UiFormActions>
          <UiButton variant="ghost" :disabled="saving" @click="emit('update:open', false)">
            {{ t('core.grigdeskCancel') }}
          </UiButton>
          <UiButton type="submit" form="grigdesk-new-task" variant="solid" tone="accent"
                    :loading="saving" :disabled="saving || loadingBoards || loadingProjects"
                    @click.prevent="save">
            <template #leading>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                   stroke-linecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </template>
            {{ t('core.grigdeskCreate') }}
          </UiButton>
        </UiFormActions>
      </div>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { useGrigdeskTasksStore } from '../../stores/grigdeskTasks.ts';
import { useBoardStore } from '../../stores/board.ts';
import { useTrackersStore } from '../../stores/trackers.ts';
import { api, failureText } from '../../shared/apiClient.ts';
import { decodeBoardNamedItems } from '../../shared/boardContracts.ts';
import type { TrackerTarget } from '../../shared/trackerTarget.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';
import { isTaskSourceId, parseTaskReference } from '../../../../shared/tasks/taskReference.ts';
import type { TaskReference } from '../../../../shared/tasks/taskReference.ts';
import {
  t, UiButton, UiDialog, UiField, UiFormActions, UiIconButton, UiInlineMessage,
  UiInput, UiSelect, UiTextarea,
} from '../../ui.ts';

defineProps<{ open: boolean }>();

const emit = defineEmits<{
  'update:open': [open: boolean];
  created: [task: TaskReference];
}>();

const store = useGrigdeskTasksStore();
const trackers = useTrackersStore();
const board = useBoardStore();
const title = ref('');
const description = ref('');
const boardId = ref('own');
const projectId = ref('');
const loadingBoards = ref(true);
const loadingProjects = ref(true);
const saving = ref(false);
const error = ref('');
const externalProjects = ref<Array<{ id: string; title: string }>>([]);
const target = ref<TrackerTarget | null>(null);

const externalBoards = computed(() => {
  const catalog = trackers.catalog;
  const enabledIds = catalog?.enabledIds ?? (catalog?.externalId ? [catalog.externalId] : []);

  return catalog?.drivers.filter((driver) => driver.id !== 'own'
    && enabledIds.includes(driver.id) && driver.capabilities.create) ?? [];
});
const selectedBoard = computed(() => externalBoards.value.find((driver) => driver.id === boardId.value));
const needsProject = computed(() => boardId.value === 'own' || !!selectedBoard.value?.capabilities.projects);
const projects = computed(() => boardId.value === 'own' ? store.projects : externalProjects.value);

/**
 * Справочник и поколение захватываются для выбранной доски до создания.
 * Смена выбора отменяет чтение и не даёт прежнему ответу заменить поля нового источника.
 */
watch(boardId, async (id, _previous, onCleanup) => {
  const controller = new AbortController();

  onCleanup(() => controller.abort());
  projectId.value = '';
  externalProjects.value = [];
  target.value = null;
  error.value = '';
  loadingProjects.value = true;

  try {
    if (id === 'own') {
      await store.loadProjects();
    } else {
      const prefix = `/api/tracker/${encodeURIComponent(id)}`;
      const context = await api.get(`${prefix}/context`, { signal: controller.signal });

      if (!isRecord(context) || !isTaskSourceId(context.source)
        || !context.source.startsWith(`${id}@`) || !Number.isSafeInteger(context.generation)) {
        throw new Error(t('core.taskSourceMismatch'));
      }

      const captured = {
        prefix,
        source: context.source,
        options: { headers: { 'x-grigdesk-tracker-generation': String(context.generation) } },
      };
      const response = needsProject.value
        ? await api.get(`${prefix}/groups`, { ...captured.options, signal: controller.signal }) : null;

      if (controller.signal.aborted) {
        return;
      }

      externalProjects.value = response ? decodeBoardNamedItems(response, 'groups')
        .map((project) => ({ id: String(project.id), title: project.name })) : [];
      target.value = captured;
    }
  } catch (failure) {
    if (!controller.signal.aborted) {
      error.value = failureText(failure);
    }
  } finally {
    if (!controller.signal.aborted) {
      loadingProjects.value = false;
    }
  }
}, { immediate: true, flush: 'sync' });

/**
 * Адрес и поколение принадлежат выбранной доске, даже если дефолт успел измениться.
 * Подтверждённый номер открывается вместе с источником и не попадает в собственный список.
 */
async function createExternalTask(): Promise<TaskReference> {
  const captured = target.value;

  if (!captured || selectedBoard.value?.status !== 'active' || !selectedBoard.value.configured) {
    throw new Error(t('core.taskSourceUnsupported'));
  }

  const result = await api.post(`${captured.prefix}/tasks`, {
    title: title.value.trim(),
    description: description.value,
    ...(needsProject.value ? { groupId: Number(projectId.value) } : {}),
  }, captured.options);
  const reference = isRecord(result) && result.ok !== false
    ? parseTaskReference(`${captured.source}:${result.id}`) : null;

  if (!reference) {
    throw new Error(t('core.invalidTaskDetails'));
  }

  void board.load(true);

  return reference;
}

/**
 * Черновик живёт до подтверждённого сохранения, включая сетевой отказ.
 * Блокировка повторного submit действует до первого await и не запускает оценку.
 */
async function save() {
  if (saving.value || loadingBoards.value || loadingProjects.value) {
    return;
  }

  if (!title.value.trim() || (needsProject.value
    && !projects.value.some((project) => project.id === projectId.value))) {
    error.value = t(needsProject.value ? 'core.grigdeskRequiredFields' : 'core.newTaskRequiredTitle');

    return;
  }

  saving.value = true;
  error.value = '';

  try {
    let task: TaskReference;

    if (boardId.value === 'own') {
      const created = await store.create({
        title: title.value.trim(),
        description: description.value,
        projectId: projectId.value,
        clientOrigin: location.origin,
      });

      task = { id: created.id, source: 'grigdesk' };
    } else {
      task = await createExternalTask();
    }

    emit('update:open', false);
    emit('created', task);
  } catch (failure) {
    error.value = failureText(failure);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    await trackers.load(true);

    const defaultId = trackers.catalog?.default ?? trackers.catalog?.externalId;
    const selected = externalBoards.value.find((driver) => driver.id === defaultId
      && driver.status === 'active' && driver.configured);

    boardId.value = selected?.id ?? 'own';
  } catch (failure) {
    error.value = failureText(failure);
  } finally {
    loadingBoards.value = false;
  }
});
</script>

<style scoped>
.new-task-form {
  display: grid;
  gap: 20px;
}

.new-task-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.new-task-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}

.new-task-icon svg {
  width: 21px;
  height: 21px;
}

.new-task-title {
  flex: 1;
  min-width: 0;
}

.new-task-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
}

.new-task-note {
  max-width: 200px;
  margin: 0;
  color: var(--ink-mid);
  font-size: 11.5px;
  line-height: 1.5;
}

@media (max-width: 600px) {
  .new-task-footer {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }

  .new-task-note {
    max-width: none;
  }
}
</style>
