import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import type { ChatOptions, ChatSummary } from '../api/contract.ts';
import { createLatest } from '../api/latest.ts';
import { onClear, useLinkStore } from './link.ts';

/**
 * Каталог настроек один на unlock-сессию и не обновляется на каждом шаге агента.
 * Отсутствие возможности старого сервера показывается явно, без выдуманных вариантов.
 */
export const useChatControlsStore = defineStore('chat-controls', () => {
  const link = useLinkStore();
  const options = ref<ChatOptions | null>(null);
  const error = ref('');
  const busy = ref(false);
  const supported = computed(() => link.features.includes('chat-controls'));
  const latest = createLatest();

  /**
   * Повторное открытие пользуется проверенным каталогом; явное обновление перечитывает его.
   * Блокировка инвалидирует поздний ответ и удаляет серверные названия и пути из памяти UI.
   */
  async function load(force = false) {
    if (!supported.value) {
      error.value = 'Для управления чатами обновите и перезапустите сервер GrigDesk.';

      return;
    }
    if (busy.value || (options.value && !force)) {
      return;
    }

    busy.value = true;
    error.value = '';

    try {
      await latest.run(() => link.api!.getChatOptions(), (value) => {
        options.value = value;
      });
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : 'Каталог недоступен.';
    } finally {
      busy.value = false;
    }
  }

  const modelName = (chat: ChatSummary) => options.value?.models.find((model) =>
    model.id === (chat.modelRef?.model || chat.model)
      && (!chat.modelRef || model.provider === chat.modelRef.provider),
  )?.name || chat.model;

  onClear(() => {
    latest.invalidate();
    options.value = null;
    error.value = '';
    busy.value = false;
  });

  return {
    options,
    error,
    busy,
    supported,
    load,
    modelName,
  };
});
