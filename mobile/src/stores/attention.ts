import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import type { Attention } from '../api/contract.ts';
import { createLatest } from '../api/latest.ts';
import { onClear, useLinkStore } from './link.ts';

type Badge = {
  count: number;
  tone: 'wait' | 'stall' | 'info' | 'run';
  label: string;
};

/**
 * Счётчики относятся ко всему серверу, а не к первой загруженной странице списка.
 * UI подписывает их на общий SSE; собственного потока или обхода графов здесь нет.
 */
export const useAttentionStore = defineStore('attention', () => {
  const link = useLinkStore();
  const value = ref<Attention | null>(null);
  const latest = createLatest();
  let pending: Promise<void> | null = null;
  let again = false;

  /**
   * Одновременные сигналы объединяются, но последний обязательно дочитывается.
   * Ошибка чтения не превращает неизвестные счётчики в нулевые.
   */
  async function load(): Promise<void> {
    if (!link.features.includes('attention')) {
      return;
    }
    if (pending) {
      again = true;

      return pending;
    }

    pending = (async () => {
      try {
        do {
          again = false;
          await latest.run(() => link.api!.getAttention(), (result) => {
            value.value = result;
          });
        } while (again && link.state?.unlocked);
      } catch {
        // Последняя известная сводка остаётся до следующего серверного сигнала.
      } finally {
        pending = null;
      }
    })();

    return pending;
  }

  const badges = computed<Record<string, Badge>>(() => {
    const data = value.value;
    const result: Record<string, Badge> = {};

    if (!data) {
      return result;
    }
    if (data.chats.waiting || data.chats.unread) {
      result['/chats'] = {
        count: data.chats.waiting || data.chats.unread,
        tone: data.chats.waiting ? 'wait' : 'info',
        label: `Ждут ответа: ${data.chats.waiting}; непрочитанные чаты: ${data.chats.unread}`,
      };
    }
    if (data.tasks.stalled || data.tasks.waiting || data.tasks.running) {
      result['/tasks'] = {
        count: data.tasks.stalled + data.tasks.waiting || data.tasks.running,
        tone: data.tasks.stalled ? 'stall' : data.tasks.waiting ? 'wait' : 'run',
        label: `Остановились: ${data.tasks.stalled}; ждут ответа: ${data.tasks.waiting}; `
          + `работают: ${data.tasks.running}`,
      };
    }

    return result;
  });

  onClear(() => {
    latest.invalidate();
    value.value = null;
    again = false;
  });

  return {
    value,
    badges,
    load,
  };
});
