<template>
  <UiDialog
    :title="preview ? 'Перенос разговора' : 'Задача и папка'"
    :confirm="intent ? 'Проверить действие' : preview ? 'Применить' : 'Продолжить'"
    :busy="busy"
    :disabled="!catalog.supported || (!preview && !valid)"
    @close="$emit('close')"
    @confirm="save"
  >
    <template v-if="!preview">
      <UiError v-if="catalog.error" :text="catalog.error" @retry="catalog.load(true)" />
      <UiSelect v-model="task" label="Задача" :options="tasks" :disabled="busy" />
      <p v-if="catalog.options?.tasksOmitted" class="mobile-muted">
        Показаны первые 2000 задач; остальные можно выбрать в веб-Кокпите.
      </p>
      <UiSelect v-model="kind" label="Папка" :options="kinds" :disabled="busy" />
      <UiSelect
        v-if="kind === 'project'"
        v-model="project"
        label="Проект"
        :options="projects"
        :disabled="busy"
      />
      <p v-if="kind === 'project' && catalog.options?.projectsOmitted" class="mobile-muted">
        Показаны первые 500 проектов; остальные доступны в веб-Кокпите.
      </p>
      <UiField
        v-if="kind === 'path'"
        v-model="path"
        label="Абсолютный путь на сервере"
        placeholder="/путь/к/проекту"
        :disabled="busy"
        :max-length="4096"
      />
    </template>
    <template v-else>
      <p class="mobile-muted">Текущая папка: {{ preview.previousDirectory }}</p>
      <p>Новая папка: {{ preview.directory }}</p>
      <p v-for="warning in preview.warnings" :key="warning" class="mobile-muted">{{ warning }}</p>
      <UiSelect
        v-model="transfer"
        label="Память разговора"
        :options="transfers"
        :disabled="busy || Boolean(intent)"
      />
      <p v-if="transfer === 'reset'">История останется в чате. Исполнитель начнёт в новой папке без прежней памяти.</p>
      <p v-else-if="transfer === 'summary'">В новую сессию будет передано резюме разговора.</p>
      <p v-else>Разговор продолжится с текущей памятью исполнителя.</p>
      <UiButton v-if="!intent" :disabled="busy" @click="preview = null">Изменить выбор</UiButton>
    </template>
    <p v-if="error" class="mobile-danger" role="alert">{{ error }}</p>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type { Chat, WorkdirChoice, WorkspacePreview } from '../api/contract.ts';
import { useChatMutation } from '../composables/useChatMutation.ts';
import { useChatControlsStore } from '../stores/chatControls.ts';
import { useLinkStore } from '../stores/link.ts';
import { UiButton, UiDialog, UiError, UiField, UiSelect } from '../ui.ts';

const props = defineProps<{ chat: Chat['chat'] }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const catalog = useChatControlsStore();
const link = useLinkStore();
const { busy, error, intent, run } = useChatMutation();
const initial = props.chat.settings?.workdir;
const task = ref(props.chat.taskId || '');
const kind = ref(initial?.kind || 'cockpit');
const project = ref(initial?.kind === 'project' ? initial.projectId : '');
const path = ref(initial?.kind === 'path' ? initial.path : '');
const preview = ref<WorkspacePreview | null>(null);
const transfer = ref('reset');
const kinds = [
  { value: 'cockpit', label: 'Кокпит' },
  { value: 'project', label: 'Проект' },
  { value: 'path', label: 'Указать путь' },
];
const tasks = computed(() => [
  { value: '', label: 'Без задачи' },
  ...(task.value && !catalog.options?.tasks.some((item) => item.id === task.value)
    ? [{ value: task.value, label: `Задача №${task.value}` }] : []),
  ...(catalog.options?.tasks || []).map((item) => ({ value: item.id, label: `№${item.id} · ${item.title}` })),
]);
const projects = computed(() => [
  {
    value: '',
    label: 'Выберите проект',
    disabled: true,
  },
  ...(catalog.options?.projects || []).map((item) => ({ value: item.id, label: item.title })),
]);
const valid = computed(() => kind.value === 'cockpit' || (kind.value === 'project'
  ? Boolean(project.value) : path.value.trim().startsWith('/')));
const transfers = computed(() => [
  ...(['none', 'resume'].includes(preview.value?.transfer || '')
    ? [{ value: 'resume', label: 'Продолжить текущую сессию' }] : []),
  ...(preview.value?.summaryAvailable ? [{ value: 'summary', label: 'Перенести резюме' }] : []),
  { value: 'reset', label: 'Начать без памяти' },
]);

/**
 * Перед записью сервер показывает реальную папку и доступные способы переноса памяти.
 * Второй шаг отправляет подписанный выбор, а не пересобирает цель из изменившейся формы.
 */
async function save() {
  if (preview.value) {
    const result = await run((saved) => link.api!.changeWorkspace(
      props.chat.id,
      preview.value!.actionToken,
      transfer.value as 'resume' | 'summary' | 'reset',
      saved,
    ));

    if (result) {
      emit('saved');
    }

    return;
  }

  const workdir: WorkdirChoice = kind.value === 'project' ? {
    kind: 'project',
    projectId: project.value,
    repoKey: initial?.kind === 'project' && initial.projectId === project.value ? initial.repoKey : null,
  } : kind.value === 'path' ? { kind: 'path', path: path.value.trim() } : { kind: 'cockpit' };
  const result = await run((saved) => link.api!.previewWorkspace(
    props.chat.id, task.value || null, workdir, saved,
  ));

  if (result) {
    preview.value = result;
    transfer.value = ['none', 'resume'].includes(result.transfer)
      ? 'resume' : result.summaryAvailable ? 'summary' : 'reset';
  }
}

void catalog.load(true);
</script>
