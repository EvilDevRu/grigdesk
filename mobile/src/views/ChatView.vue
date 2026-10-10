<template>
  <section
    class="pane chat-pane"
    :style="{ '--composer-height': layout.composerHeight + 'rem' }"
  >
    <ChatHeader :key="id" :chat="current?.chat || null" :title="listed?.title || 'Чат'"
      @changed="settingsChanged" />
    <div ref="scroller" class="pane-body chat-scroll" @scroll.passive="onScroll">
      <div ref="feed" class="chat-feed mobile-feed" aria-live="polite">
        <UiError
          v-if="store.chatError || error"
          :text="store.chatError || error"
          @retry="reload"
        />
        <p v-if="!current && !store.chatError && !error" class="list-loading" role="status">
          Загрузка…
        </p>
        <UiEmpty
          v-if="current && !current.messages.length && !optimistic.length && !requests.length"
          icon="chats"
          text="Начните разговор"
        >
          <p>Напишите агенту — ответ появится здесь.</p>
        </UiEmpty>
        <UiButton v-if="current?.hasMore" class="chat-older" :busy="store.busy" @click="older">
          Ранее
        </UiButton>
        <section
          v-for="group in groups"
          :key="group.key"
          class="chat-message-group"
          :class="{ 'chat-turn': group.turn }"
        >
          <header v-if="group.turn" class="chat-run-head">
            <UiIcon name="activity" />
            <span>Ход агента</span>
            <time>{{ clock(group.messages[0].at) }}</time>
          </header>
          <article
            v-for="message in group.messages"
            :key="message.id"
            class="chat-message mobile-message"
            :data-role="message.role"
          >
            <div v-if="message.role === 'user'" class="chat-bubble">
              <MessageBody :message="message" :chat-id="id" />
              <span class="chat-meta">{{ clock(message.at) }}</span>
            </div>
            <template v-else>
              <ChatActivity v-if="message.activity" :activity="message.activity" />
              <div class="chat-answer">
                <UiIcon name="chats" />
                <MessageBody :message="message" :chat-id="id" />
              </div>
            </template>
            <div v-if="message.stopped || message.error" class="chat-flags">
              <UiChip v-if="message.stopped" tone="warn">Остановлено</UiChip>
              <UiChip v-if="message.error" tone="bad">Ошибка</UiChip>
            </div>
          </article>
        </section>
        <article
          v-for="item in optimistic"
          :key="item.clientId"
          class="chat-message mobile-message"
          data-role="user"
        >
          <div class="chat-bubble" data-pending="true">
            <p class="mobile-prose">{{ JSON.parse(item.body).text }}</p>
          </div>
          <div class="chat-flags">
            <UiChip :tone="item.state === 'failed' ? 'bad' : 'warn'">
              {{ outboxLabel(item.state) }}
            </UiChip>
            <p v-if="item.error" class="mobile-muted">{{ item.error }}</p>
            <UiButton v-if="item.state === 'failed'" @click="store.outbox?.discard(item)">
              Убрать
            </UiButton>
            <UiButton
              v-else-if="['checking', 'waiting'].includes(item.state)"
              @click="store.outbox?.flush(id)"
            >
              Проверить доставку
            </UiButton>
          </div>
        </article>
        <section v-if="current?.activity || running" class="chat-turn chat-live-turn">
          <header class="chat-run-head">
            <UiChatAvatar
              v-if="current?.chat.provider"
              class="chat-run-provider"
              title="Агент"
              :provider="current.chat.provider"
            />
            <UiIcon v-else name="activity" />
            <span>{{ current?.chat.provider?.name || 'Ход агента' }}</span>
          </header>
          <ChatActivity v-if="current?.activity" :activity="current.activity" live />
          <div v-if="running" class="chat-thinking" role="status">
            <span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span>{{ runStatus }}</span>
          </div>
        </section>
        <WaitingCard v-for="item in requests" :key="item.pid" :item="item" @answered="reload" />
      </div>
    </div>
    <form class="chat-composer mobile-composer" data-touch-density="compact" @submit.prevent="send">
      <p v-if="link.network !== 'online'" class="chat-offline" role="status">
        Нет связи: сообщение сохранится и уйдёт, когда связь вернётся.
      </p>
      <div class="composer-box">
        <textarea
          ref="input"
          v-model="text"
          class="composer-input"
          aria-label="Сообщение"
          rows="1"
          maxlength="32000"
          placeholder="Написать агенту…"
          @input="grow"
          @keydown.enter.ctrl.prevent="send"
          @keydown.enter.meta.prevent="send"
        ></textarea>
        <div class="composer-actions">
          <UiButton
            v-if="!atBottom"
            class="chat-to-bottom"
            aria-label="К последним сообщениям"
            @click="follow(true)"
          >
            <UiIcon name="down" />
          </UiButton>
          <UiButton
            v-if="current?.chat.actions.stop"
            kind="danger"
            variant="solid"
            class="composer-stop"
            aria-label="Стоп"
            @click="stopping = true"
          >
            <UiIcon name="stop" />
          </UiButton>
          <UiButton
            kind="primary"
            variant="solid"
            class="composer-send"
            aria-label="Отправить"
            :busy="sending"
            :disabled="!text.trim()"
            @click="send"
          >
            <UiIcon name="send" />
            <span class="composer-send-label">Отправить</span>
          </UiButton>
        </div>
      </div>
    </form>
    <UiDialog
      v-if="stopping"
      title="Остановить ход?"
      confirm="Остановить"
      danger
      :busy="sending"
      @close="stopping = false"
      @confirm="stop"
    >
      <p>Текущий ход и очередь этого чата будут остановлены.</p>
    </UiDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import MessageBody from '../components/MessageBody.vue';
import ChatActivity from '../components/ChatActivity.vue';
import WaitingCard from '../components/WaitingCard.vue';
import ChatHeader from '../components/ChatHeader.vue';
import {
  UiButton, UiChatAvatar, UiChip, UiDialog, UiEmpty, UiError, UiIcon,
} from '../ui.ts';
import { clock } from '../ui/format.ts';
import { useChatsStore } from '../stores/chats.ts';
import { onSignal, useLinkStore } from '../stores/link.ts';
import { useReload } from '../composables/useReload.ts';
import { ApiError } from '../api/client.ts';
import { useChatLayoutStore } from '../stores/chatLayout.ts';
import { groupMessages } from '../components/chatTimeline.ts';
import { activityStatus } from '../components/chatActivityView.ts';
import { useAttentionStore } from '../stores/attention.ts';

const route = useRoute();
const store = useChatsStore();
const link = useLinkStore();
const layout = useChatLayoutStore();
const attention = useAttentionStore();
const id = computed(() => String(route.params.id));
const current = computed(() => (store.current?.chat.id === id.value ? store.current : null));
const groups = computed(() => groupMessages(current.value?.messages || []));
// Пока длинная история грузится, шапка уже знает название из списка.
const listed = computed(() => store.list?.chats.find((chat) => chat.id === id.value) || null);
const requests = computed(
  () => store.waiting?.items.filter((item) => item.chatId === id.value) || [],
);
const text = computed({
  get: () => store.drafts[id.value] || '',
  set: (value: string) => {
    store.drafts[id.value] = value;
  },
});
const atBottom = ref(true);
const error = ref('');
const thinking = ref(false);
const running = computed(() => thinking.value || current.value?.chat.state === 'running');
const runStatus = computed(() => activityStatus(current.value?.activity, requests.value.length > 0));
const sending = ref(false);
const stopping = ref(false);
const scroller = ref<HTMLElement | null>(null);
const feed = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);
const outboxLabel = (state: string) =>
  ({
    sending: 'Отправляется',
    checking: 'Проверяем доставку',
    waiting: 'Ждёт сети',
    previous: 'Ждёт предыдущего',
    failed: 'Не отправлено',
  })[state] || state;
const optimistic = computed(() => {
  void store.tick;

  const known = new Set(current.value?.messages.map((message) => message.clientId) || []);

  return (
    store.outbox?.items.filter((item) => item.chatId === id.value && !known.has(item.clientId!)) ||
    []
  );
});
const reload = async () => {
  await Promise.all([store.loadChat(id.value), store.loadWaiting()]);
};
const settingsChanged = () => Promise.all([reload(), store.loadList(), attention.load()]);
let readRevision = '';

/**
 * Непрочитанное гасится лишь когда открыт низ именно этой ревизии разговора.
 * Чтение истории выше и поздний ответ другого хода не считаются просмотром нового ответа.
 */
async function markRead() {
  const chat = current.value?.chat;
  const key = `${chat?.id}:${chat?.revision}`;

  if (!chat?.unread || !chat.actions.read || !atBottom.value || key === readRevision
    || !link.state?.unlocked || document.visibilityState === 'hidden') {
    return;
  }

  readRevision = key;

  try {
    await link.api!.readChat(chat.id, chat.actions.read);
    await settingsChanged();
  } catch {
    // Следующая ревизия повторит CAS; старый снимок не гасит новый ответ.
  }
}

let refreshing = false;
let refreshAgain = false;
let disposed = false;

/**
 * Сигналы шага приходят чаще медленного ответа через посредника: чтение не вытесняется само собой.
 * Последний сигнал обязательно дочитывается: done во время запроса не оставляет вечный running.
 */
async function refreshProgress() {
  if (refreshing) {
    refreshAgain = true;

    return;
  }

  refreshing = true;

  try {
    do {
      refreshAgain = false;
      await store.loadChat(id.value);
    } while (refreshAgain && !disposed && link.state?.unlocked);
  } finally {
    refreshing = false;
  }
}

// Лента держится у последнего сообщения, пока человек сам не отлистал вверх.
// Признак обновляет только прокрутка: рост ленты и клавиатура событий scroll не дают.
let stick = true;
let observer: ResizeObserver | null = null;
const onScroll = () => {
  const element = scroller.value;

  if (element) {
    stick = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    atBottom.value = stick;
  }
};
const pin = () => {
  if (stick && scroller.value) {
    scroller.value.scrollTop = scroller.value.scrollHeight;
  }
};

/**
 * Новое сообщение, ответ или открытый чат показывают низ ленты после отрисовки.
 * С force лента возвращается вниз и после того, как человек читал историю выше.
 */
async function follow(force = false) {
  if (force) {
    stick = true;
    atBottom.value = true;
  }

  await nextTick();
  pin();
}

/**
 * Поле растёт вместе с текстом до предела из CSS, дальше прокручивается само.
 * После отправки высота возвращается к одной строке.
 */
function grow() {
  const element = input.value;

  if (!element) {
    return;
  }

  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

/**
 * Ранние сообщения добавляются сверху, а человек остаётся на том же месте ленты:
 * сдвиг прокрутки равен высоте подгруженной истории.
 */
async function older() {
  const element = scroller.value;
  const fromBottom = element ? element.scrollHeight - element.scrollTop : 0;

  await store.older();
  await nextTick();

  if (element) {
    element.scrollTop = element.scrollHeight - fromBottom;
  }
}

/**
 * Composer очищается после durable записи native, до ожидания сетевого ACK.
 * Один стор владеет очередью, поэтому смена экрана не теряет сообщение.
 */
async function send() {
  if (sending.value || !text.value.trim()) {
    return;
  }

  sending.value = true;
  error.value = '';

  const chatId = id.value;
  const draft = text.value;

  try {
    await store.send(chatId, draft.trim());

    if (store.drafts[chatId] === draft) {
      store.drafts[chatId] = '';
    }

    await nextTick();
    grow();

    if (id.value === chatId) {
      await follow(true);
    }
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Сообщение не сохранено.';
  } finally {
    sending.value = false;
  }
}

/**
 * Стоп берёт токен показанного запуска; конфликт требует нового решения после чтения.
 * Неопределённый результат не запускает stop по новой идентичности.
 */
async function stop() {
  const token = current.value?.chat.actions.stop;

  if (!token) {
    stopping.value = false;

    return;
  }

  sending.value = true;

  try {
    await link.api!.stopChat(id.value, token);
  } catch (failure) {
    error.value =
      failure instanceof ApiError && failure.status === 409
        ? 'Уже решено в другом окне.'
        : failure instanceof Error
          ? failure.message
          : 'Стоп не подтверждён.';
  } finally {
    sending.value = false;
    stopping.value = false;
    await reload();
  }
}

const unsubscribe = onSignal((name, value) => {
  if (name === 'chat' && value.chatId === id.value) {
    thinking.value = value.kind === 'progress';
  }
});

useReload(
  refreshProgress,
  ['chat'],
  (value) => value.chatId === id.value,
);
useReload(store.loadWaiting, ['waiting']);
watch(id, () => {
  stopping.value = false;
  thinking.value = false;
  stick = true;
  void nextTick(grow);
  void reload();
});
watch(() => layout.composerHeight, () => void nextTick(grow));
watch(() => [current.value?.chat.revision, current.value?.chat.unread, atBottom.value], markRead);
watch(
  () => store.tick,
  () => {
    if (link.state?.unlocked && !store.outbox?.items.some((item) => item.chatId === id.value)) {
      void store.loadChat(id.value);
    }
  },
);
watch(
  () => [
    current.value?.chat.id,
    current.value?.messages.at(-1)?.id,
    optimistic.value.length,
    requests.value.length,
    thinking.value,
  ],
  () => void follow(),
);
onMounted(() => {
  void follow(true);

  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(pin);

    for (const element of [scroller.value, feed.value]) {
      if (element) {
        observer.observe(element);
      }
    }
  }
});
onScopeDispose(() => {
  disposed = true;
  refreshAgain = false;
  observer?.disconnect();
  unsubscribe();
});
void store.restore();
</script>
