import { onScopeDispose } from 'vue';
import { onSignal } from './link.ts';
import { defineStore } from 'pinia';
import { markRaw, ref, shallowRef } from 'vue';

import type { Chat, Chats, Waiting } from '../api/contract.ts';
import { createLatest } from '../api/latest.ts';
import { ChatOutbox } from '../api/outbox.ts';
import { onClear, useLinkStore } from './link.ts';

/**
 * История и списки перечитываются по независимым latest counters.
 * Очередь сообщений переживает экран, а на lock очищается только её видимое представление.
 */
export const useChatsStore = defineStore('chats', () => {
  const link = useLinkStore();
  const list = ref<Chats | null>(null);
  const current = ref<Chat | null>(null);
  const waiting = ref<Waiting | null>(null);
  const error = ref('');
  const chatError = ref('');
  const busy = ref(false);
  const tick = ref(0);
  const drafts = ref<Record<string, string>>({});
  const outbox = shallowRef<ChatOutbox | null>(null);
  const listLatest = createLatest();
  const chatLatest = createLatest();
  const waitingLatest = createLatest();

  /**
   * Владелец outbox создаётся один раз на текущий API и не зависит от route mount.
   * Callback обновляет optimistic представление и затем серверную историю при proven ACK.
   */
  function queue() {
    if (!outbox.value) {
      outbox.value = markRaw(
        new ChatOutbox(link.api!, () => {
          tick.value += 1;
        }),
      );
    }

    return outbox.value;
  }

  /**
   * Ошибка читается на экране, а stale запрос не сбрасывает более свежий результат.
   * Список и открытый чат держат свои ошибки: на планшете они видны рядом, и сбой одного
   * не повторяется в другой колонке. Busy используется для кнопки, не блокируя invalidate.
   */
  async function run(action: () => Promise<void>, target = error) {
    busy.value = true;
    target.value = '';

    try {
      await action();
    } catch (failure) {
      target.value = failure instanceof Error ? failure.message : 'Нет связи с Кокпитом.';
    } finally {
      busy.value = false;
    }
  }

  const loadList = () =>
    run(() =>
      listLatest.run(
        () => link.api!.getChats(),
        (value) => {
          list.value = value;
        },
      ),
    );
  const loadChat = (id: string) =>
    run(
      () =>
        chatLatest.run(
          () => link.api!.getChat(id),
          (value) => {
            const previous = current.value;

            if (previous?.chat.id === id && previous.chat.revision === value.chat.revision) {
              const first = value.messages[0]?.index ?? Infinity;
              const older = previous.messages.filter((message) => message.index < first);

              if (older.length) {
                value.messages = [...older, ...value.messages];
                value.hasMore = previous.hasMore;
                value.nextBefore = previous.nextBefore;
              }
            }

            current.value = value;
          },
        ),
      chatError,
    );
  const loadWaiting = () =>
    run(
      () =>
        waitingLatest.run(
          () => link.api!.getWaiting(),
          (value) => {
            waiting.value = value;
          },
        ),
      chatError,
    );

  /**
   * Старая страница применяется только к прежним chat/revision после актуального чтения.
   * 409 history_changed сбрасывает курсор и читает последнюю страницу заново.
   */
  async function older() {
    const snapshot = current.value;

    if (!snapshot || !snapshot.hasMore) {
      return;
    }

    await run(async () => {
      try {
        const page = await link.api!.getChat(
          snapshot.chat.id,
          snapshot.nextBefore!,
          snapshot.chat.revision,
        );

        if (current.value === snapshot) {
          current.value = {
            ...page,
            messages: [...page.messages, ...snapshot.messages],
          };
        }
      } catch {
        await loadChat(snapshot.chat.id);
      }
    }, chatError);
  }

  const send = (id: string, text: string) => queue().enqueue(id, text);
  const restore = () => queue().restore();

  const stopSignals = onSignal((name) => {
    if (name === 'ready' && outbox.value) {
      void outbox.value.reconnect();
    }
  });

  onScopeDispose(stopSignals);

  onClear(() => {
    listLatest.invalidate();
    chatLatest.invalidate();
    waitingLatest.invalidate();
    list.value = null;
    current.value = null;
    waiting.value = null;
    error.value = '';
    chatError.value = '';
    drafts.value = {};
    outbox.value?.clear();
  });

  return {
    list,
    current,
    waiting,
    error,
    chatError,
    busy,
    outbox,
    tick,
    drafts,
    loadList,
    loadChat,
    loadWaiting,
    older,
    send,
    restore,
    queue,
  };
});
