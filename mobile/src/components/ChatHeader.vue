<template>
  <UiPaneHeader class="chat-header" :title="chat?.title || title" back="/chats" back-label="Все чаты"
    data-touch-density="compact">
    <template #actions>
      <UiButton class="chat-selector chat-task" variant="ghost" :disabled="!editable"
        :aria-label="`Задача: ${taskLabel}`" @click="workspace = true">
        <span class="chat-control-label">Задача</span>
        <span class="chat-selector-value" :aria-label="taskLabel">{{ taskLabel }}</span>
        <UiIcon name="chevron" />
      </UiButton>
      <UiButton class="chat-selector chat-folder" variant="ghost" :disabled="!editable"
        :aria-label="`Папка: ${chat?.settings?.directory || folderLabel}`" @click="workspace = true">
        <UiIcon name="folder" />
        <span class="chat-selector-value" :aria-label="folderLabel">{{ folderLabel }}</span>
        <UiIcon name="chevron" />
      </UiButton>
      <UiChatLayout />
    </template>
    <template #bottom>
      <span class="chat-header-status">{{ status }}</span>
      <div class="chat-model-controls">
        <UiButton class="chat-selector chat-model" variant="ghost" :disabled="!editable"
          :aria-label="`Модель: ${model?.name || chat?.model || 'не выбрана'}`" @click="modelOpen = true">
          <span class="chat-control-label">Модель</span>
          <span class="chat-selector-value" :aria-label="model?.name || chat?.model || 'Модель'">
            {{ model?.name || chat?.model || 'Модель' }}
          </span>
          <UiIcon name="chevron" />
        </UiButton>
        <UiEffort :value="pendingEffort ?? chat?.effort ?? ''" :levels="model?.efforts || []"
          :disabled="!editable || busy || Boolean(intent)" @change="changeEffort" />
        <UiContextRing :percent="context.percent" :label="context.label" @click="contextOpen = true" />
      </div>
      <div v-if="error" class="chat-control-error" role="alert">
        <span>{{ error }}</span>
        <UiButton v-if="intent" @click="changeEffort(pendingEffort || '')">Проверить действие</UiButton>
      </div>
    </template>
  </UiPaneHeader>
  <ChatModelDialog v-if="modelOpen && chat" :chat="snapshot!" @close="modelOpen = false" @saved="saved" />
  <ChatWorkspaceDialog v-if="workspace && chat" :chat="snapshot!" @close="workspace = false" @saved="saved" />
  <UiDialog v-if="contextOpen" title="Контекст разговора" confirm="Понятно"
    @close="contextOpen = false" @confirm="contextOpen = false">
    <dl class="context-details">
      <dt>В контексте</dt><dd>{{ count(context.tokens) }}{{ chat?.settings?.context.estimate ? ' · оценка' : '' }}</dd>
      <dt>Окно модели</dt><dd>{{ count(context.window) }}</dd>
      <template v-if="model?.autoCompact">
        <dt>Порог сжатия</dt><dd>{{ count(context.threshold) }}</dd>
      </template>
      <dt>Источник</dt><dd>{{ chat?.settings?.context.live ? 'Текущий ход' : 'Последний замер' }}</dd>
    </dl>
    <p v-if="context.percent === null" class="mobile-muted">Исполнитель ещё не передал замер контекста.</p>
    <p v-if="!catalog.supported" class="mobile-muted">Обновите и перезапустите сервер для управления чатом.</p>
  </UiDialog>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';

import type { Chat } from '../api/contract.ts';
import { useChatControlsStore } from '../stores/chatControls.ts';
import { useLinkStore } from '../stores/link.ts';
import { useChatMutation } from '../composables/useChatMutation.ts';
import { useReload } from '../composables/useReload.ts';
import { UiButton, UiChatLayout, UiContextRing, UiDialog, UiEffort, UiIcon, UiPaneHeader } from '../ui.ts';
import ChatModelDialog from './ChatModelDialog.vue';
import ChatWorkspaceDialog from './ChatWorkspaceDialog.vue';
import { contextDisplay } from './chatContext.ts';

const props = defineProps<{ chat: Chat['chat'] | null; title: string }>();
const emit = defineEmits<{ changed: [] }>();
const catalog = useChatControlsStore();
const link = useLinkStore();
const { busy, error, intent, run } = useChatMutation();
const pendingEffort = ref<string | null>(null);
const modelOpen = ref(false);
const workspace = ref(false);
const contextOpen = ref(false);
const snapshot = shallowRef<Chat['chat']>();
const editable = computed(() => Boolean(props.chat?.actions.configure) && catalog.supported && !busy.value);
const model = computed(() => catalog.options?.models.find((item) =>
  props.chat?.modelRef
    ? item.provider === props.chat.modelRef.provider && item.id === props.chat.modelRef.model
    : item.id === props.chat?.model,
));
const context = computed(() => contextDisplay(props.chat?.settings?.context, model.value));
const taskLabel = computed(() => {
  const id = props.chat?.taskId;
  const task = catalog.options?.tasks.find((item) => item.id === id);

  return id ? `№${id}${task ? ' · ' + task.title : ''}` : 'Без задачи';
});
const folderLabel = computed(() => {
  const workdir = props.chat?.settings?.workdir;
  const directory = props.chat?.settings?.directory;

  if (directory?.startsWith('/')) {
    return directory.split('/').filter(Boolean).at(-1) || '/';
  }

  return workdir?.kind === 'path' ? workdir.path.split('/').filter(Boolean).at(-1) || '/'
    : workdir?.kind === 'project'
      ? catalog.options?.projects.find((item) => item.id === workdir.projectId)?.title || workdir.projectId
      : 'Кокпит';
});
const status = computed(() => props.chat?.state === 'running' ? 'Агент работает'
  : props.chat?.state === 'queued' ? 'В очереди' : 'Готов к следующему ходу');
const count = (value: number | null) => value === null
  ? 'Нет данных' : Math.round(value).toLocaleString('ru');

watch([modelOpen, workspace], ([a, b]) => {
  if (a || b) {
    snapshot.value = props.chat || undefined;
  }
});
watch(() => props.chat?.id, () => {
  modelOpen.value = false;
  workspace.value = false;
  contextOpen.value = false;
});

/**
 * Успешная форма перечитывает чат и список, сохраняя прежнюю позицию и черновик.
 * Закрытие отменой не отправляет никакой мутации.
 */
function saved() {
  modelOpen.value = false;
  workspace.value = false;
  emit('changed');
}

/**
 * Ползунок сохраняется по отпусканию, с токеном показанной ревизии и точной парой модели.
 * При неопределённом результате повторяется прежнее намерение, а не новое усилие.
 */
async function changeEffort(effort: string) {
  const chat = props.chat;
  const modelRef = chat?.settings?.modelRef || chat?.modelRef;

  if (!chat || !modelRef || (!intent.value && !editable.value)) {
    return;
  }

  pendingEffort.value = effort;
  await run((saved) => link.api!.configureChat(chat.id, {
    modelRef,
    effort,
    reset: false,
    actionToken: chat.actions.configure || '',
  }, saved));
  emit('changed');

  if (!intent.value) {
    pendingEffort.value = null;
  }
}

useReload(() => catalog.load(), []);
</script>
