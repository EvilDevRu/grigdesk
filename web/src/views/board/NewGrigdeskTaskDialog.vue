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
      <UiField id="grigdesk-task-title" :label="t('core.grigdeskTaskTitle')" required>
        <UiInput v-model="title" :placeholder="t('core.grigdeskTaskTitlePlaceholder')"
                 :maxlength="500" :disabled="saving" />
      </UiField>
      <UiField :label="t('core.grigdeskTaskProject')" required>
        <UiSelect v-model="projectId" :disabled="saving">
          <option value="">{{ t('core.grigdeskChooseProject') }}</option>
          <option v-for="project in store.projects" :key="project.id" :value="project.id">
            {{ project.title }}
          </option>
        </UiSelect>
      </UiField>
      <UiInlineMessage v-if="!loadingProjects && !store.projects.length">
        {{ t('core.grigdeskNoProjects') }}
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
                    :loading="saving" :disabled="saving" @click.prevent="save">
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
import { onMounted, ref } from 'vue';

import { useGrigdeskTasksStore } from '../../stores/grigdeskTasks.ts';
import { failureText } from '../../shared/apiClient.ts';
import {
  t, UiButton, UiDialog, UiField, UiFormActions, UiIconButton, UiInlineMessage,
  UiInput, UiSelect, UiTextarea,
} from '../../ui.ts';

defineProps<{ open: boolean }>();

const emit = defineEmits<{
  'update:open': [open: boolean];
  created: [id: string];
}>();

const store = useGrigdeskTasksStore();
const title = ref('');
const description = ref('');
const projectId = ref('');
const loadingProjects = ref(true);
const saving = ref(false);
const error = ref('');

/**
 * Черновик живёт до подтверждённого сохранения, включая сетевой отказ.
 * Блокировка повторного submit действует до первого await и не запускает оценку.
 */
async function save() {
  if (saving.value) {
    return;
  }

  if (!title.value.trim() || !store.projects.some((project) => project.id === projectId.value)) {
    error.value = t('core.grigdeskRequiredFields');

    return;
  }

  saving.value = true;
  error.value = '';

  try {
    const task = await store.create({
      title: title.value.trim(),
      description: description.value,
      projectId: projectId.value,
      clientOrigin: location.origin,
    });

    emit('update:open', false);
    emit('created', task.id);
  } catch (failure) {
    error.value = failureText(failure);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    await store.loadProjects();
  } catch (failure) {
    error.value = failureText(failure);
  } finally {
    loadingProjects.value = false;
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
