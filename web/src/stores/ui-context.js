// Контекст интерфейса для чата с агентом: что открыто у пользователя прямо сейчас.
// Страницы репортят свои детали через set()/clear() (профиль маршрутов, таб настроек,
// выбранный агент и т.п.), а чат при отправке прикладывает снимок к сообщению —
// агент понимает просьбы вида «поправь здесь», не заставляя описывать место словами.
import { defineStore } from 'pinia';

export const useUiContextStore = defineStore('uiContext', {
  state: () => ({ extra: {} }),
  actions: {
    set(key, val) { this.extra[key] = val; },
    clear(key) { delete this.extra[key]; },
  },
});
