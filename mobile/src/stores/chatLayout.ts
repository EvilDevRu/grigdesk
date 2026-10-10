import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

const key = 'cockpit-mobile-chat-layout';

/**
 * На устройстве сохраняется только геометрия, без текста, чатов и данных привязки.
 * Повреждённая или недоступная настройка оставляет безопасные размеры по умолчанию.
 */
export const useChatLayoutStore = defineStore('chat-layout', () => {
  const listVisible = ref(true);
  const listWidth = ref(19);
  const composerHeight = ref(3);

  try {
    const saved = JSON.parse(window.localStorage.getItem(key) || '{}');

    listVisible.value = saved.listVisible !== false;
    listWidth.value = valid(saved.listWidth, 15, 26, 19);
    composerHeight.value = valid(saved.composerHeight, 3, 15, 3);
  } catch {
    // Приватный режим может запрещать localStorage; раскладка продолжает работать.
  }

  watch([listVisible, listWidth, composerHeight], () => {
    try {
      window.localStorage.setItem(key, JSON.stringify({
        listVisible: listVisible.value,
        listWidth: listWidth.value,
        composerHeight: composerHeight.value,
      }));
    } catch {
      // Геометрия текущего окна не зависит от успешного сохранения настройки.
    }
  });

  return {
    listVisible,
    listWidth,
    composerHeight,
  };
});

const valid = (value: unknown, minimum: number, maximum: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value)) : fallback;
