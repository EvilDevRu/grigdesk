<template>
  <UiSplit empty-text="Выберите чат в списке" empty-icon="chats" chat-layout>
    <UiPaneHeader class="chat-list-title" title="Чаты" brand status />
    <UiChatListTools
      v-model:query="query"
      v-model:archived="archived"
      :archive-count="archiveCount"
      :partial="store.list?.hasMore"
      @create="creating = true"
    />
    <div class="pane-body">
      <p v-if="store.list?.hasMore" class="list-scope chat-list-scope">
        Поиск и архив по загруженным чатам. Остальные — «Показать ещё».
      </p>
      <div class="list-body">
        <UiError v-if="store.error" :text="store.error" @retry="store.loadList" />
        <p v-if="!store.list && !store.error" class="list-loading" role="status">Загрузка…</p>
        <UiEmpty v-if="store.list && !store.list.chats.length" icon="chats" text="Чатов пока нет">
          <UiButton @click="creating = true">Создать чат</UiButton>
        </UiEmpty>
        <UiEmpty
          v-if="store.list?.chats.length && !visible.length"
          icon="search"
          text="Чаты не найдены"
        >
          <UiButton @click="
            query = '';
            archived = false;
          ">Сбросить фильтры</UiButton>
        </UiEmpty>
        <UiListRow
          v-for="chat in visible"
          :key="chat.id"
          class="chat-row"
          :data-wait="chat.waiting ? 'true' : undefined"
          :data-unread="chat.unread ? 'true' : undefined"
          :label="chat.title"
          :current="chat.id === activeId"
          :to="'/chats/' + encodeURIComponent(chat.id)"
        >
          <template #lead>
            <UiChatAvatar
              :title="chat.title"
              :provider="chat.provider"
              :running="chat.state === 'running'"
            />
          </template>
          <span class="row-line">
            <strong class="row-title" :aria-label="chat.title">{{ chat.title }}</strong>
            <span class="row-model" :aria-label="catalog.modelName(chat)">{{ catalog.modelName(chat) }}</span>
          </span>
          <span class="row-preview-line">
            <span class="row-snippet" :aria-label="snippet(chat)">
              <span v-if="store.drafts[chat.id]" class="row-draft">Черновик: </span>
              {{ snippet(chat) }}
            </span>
            <span class="row-time">{{ ago(chat.updatedAt) }}</span>
          </span>
        </UiListRow>
        <UiButton v-if="store.list?.hasMore" :busy="store.busy" @click="more">Показать ещё</UiButton>
      </div>
    </div>
  </UiSplit>
  <ChatModelDialog v-if="creating" @close="creating = false" @saved="created" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  UiButton,
  UiChatAvatar,
  UiChatListTools,
  UiEmpty,
  UiError,
  UiListRow,
  UiPaneHeader,
  UiSplit,
} from '../ui.ts';
import { ago } from '../ui/format.ts';
import type { ChatSummary } from '../api/contract.ts';
import { useChatsStore } from '../stores/chats.ts';
import { useLinkStore } from '../stores/link.ts';
import { useReload } from '../composables/useReload.ts';
import { useChatControlsStore } from '../stores/chatControls.ts';
import ChatModelDialog from '../components/ChatModelDialog.vue';

const route = useRoute();
const router = useRouter();
const catalog = useChatControlsStore();
const creating = ref(false);
const store = useChatsStore();
const link = useLinkStore();
const activeId = computed(() => String(route.params.id || ''));
const query = ref('');
const archived = ref(false);
const archiveCount = computed(() => store.list?.chats.filter((chat) => chat.archived).length || 0);
const snippet = (chat: ChatSummary) => store.drafts[chat.id]
  || (chat.waiting ? `Ждёт ответа: ${chat.waiting}` : '')
  || (chat.state === 'queued' ? 'В очереди' : '')
  || chat.preview
  || (chat.state === 'running' ? 'Агент работает…' : 'Откройте разговор');
const visible = computed(() => {
  const search = query.value.trim().toLocaleLowerCase('ru');

  return (store.list?.chats || []).filter((chat) =>
    (!search || `${chat.title} ${chat.model} ${snippet(chat)}`.toLocaleLowerCase('ru').includes(search)) &&
    Boolean(chat.archived) === archived.value,
  );
});

/**
 * Новый чат открывается после подтверждённого создания, а фильтр архива возвращается к активным.
 * Список перечитывается с сервера, чтобы не выдумывать ревизию или модель созданной строки.
 */
async function created(id: string) {
  creating.value = false;
  archived.value = false;
  query.value = '';
  await store.loadList();
  await router.push('/chats/' + encodeURIComponent(id));
}

/**
 * Страница списка дополняется только при неизменном снимке после получения ответа.
 * Новый resync сбрасывает старый cursor, поэтому он не дублирует строки.
 */
async function more() {
  const snapshot = store.list;

  if (!snapshot?.nextCursor) {
    return;
  }

  try {
    const page = await link.api!.getChats(snapshot.nextCursor);

    if (store.list === snapshot) {
      store.list = {
        ...page,
        chats: [...snapshot.chats, ...page.chats],
      };
    }
  } catch (failure) {
    store.error = failure instanceof Error ? failure.message : 'Список недоступен.';
  }
}

// progress идёт раз в секунду на ход и не меняет строку списка: состояние и время
// обновляют turn-start, queued, done и message того же чата.
useReload(store.loadList, ['chats', 'chat', 'waiting'], (value) => value?.kind !== 'progress');
useReload(() => catalog.load(), []);
</script>
