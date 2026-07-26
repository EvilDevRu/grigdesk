// Реестр LLM-исполнителей (GET /api/providers): топбар рисует иконки доступных,
// схемы/маршруты смогут выбирать исполнителя по стабильному id из этого списка.
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';

let usageAt = 0;

export const useProvidersStore = defineStore('providers', {
  // showAllModels — настройка «показывать все модели, включая старые версии» (server prefs).
  // Держим её здесь же: список моделей приходит полным, тумблер только фильтрует показ.
  state: () => ({ providers: [], usage: {}, loaded: false, showAllModels: false }),
  getters: {
    /**
     * Модель по умолчанию: сильнейшая из видимых в кратком списке (не `extra`) у доступного
     * исполнителя. Алиас `opus` дефолтом не берём — он скрыт и указывает на ту же модель,
     * что и первый пункт списка. Пока реестр не загружен — фоллбэк на алиас.
     */
    defaultModelId(state) {
      for (const p of state.providers) {
        if (!p.available) continue;
        const m = (p.models || []).find((x) => !x.extra);
        if (m) return m.id;
      }
      return 'opus';
    },
    /**
     * Модели исполнителя, которые видно в выборе. Правило одно на весь кокпит: краткий
     * список = только свежие версии, `extra` (старые версии) — под настройкой; выбранную
     * сейчас модель показываем всегда, иначе селект потеряет значение.
     */
    visibleModels: (state) => (provider, selectedId = null) =>
      (provider?.models || []).filter((m) => state.showAllModels || !m.extra || m.id === selectedId),
    /**
     * Сохранённый выбор → реальная модель. Алиас CLI (`opus`, `sonnet`, `haiku`) отдельным
     * пунктом не показывается: он привязан к модели, в которую резолвится (`aliases`).
     * Поэтому старый выбор «opus» показывается и уходит как «Opus 4.6», а после обновления
     * бинаря — как «Opus 5», без ручных миграций сохранённых чатов.
     */
    resolveModelId: (state) => (id) => {
      if (!id) return '';
      for (const p of state.providers) {
        for (const m of p.models || []) {
          if (m.id === id || (m.aliases || []).includes(id)) return m.id;
        }
      }
      return id; // реестр не загружен или модель незнакомая — отдаём как есть
    },
  },
  actions: {
    async load(refresh = false) {
      try {
        const { providers, showAllModels } = await api.get(`/api/providers${refresh ? '?refresh=1' : ''}`);
        this.providers = providers || [];
        this.showAllModels = !!showAllModels;
      } catch { /* сервер молчит — иконок просто нет */ }
      this.loaded = true;
    },
    // Потребление лимитов (прогрессбары в тултипе иконки исполнителя). Кэш минута.
    async loadUsage() {
      if (Date.now() - usageAt < 60_000) return;
      usageAt = Date.now();
      try {
        const { usage } = await api.get('/api/providers/usage');
        this.usage = usage || {};
      } catch { /* эндпоинта нет / сервер молчит — баров просто нет */ }
    },
  },
});
