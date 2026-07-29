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
     * Поэтому старый выбор «opus» показывается и уходит как актуальная Opus установленного
     * CLI, без ручных миграций сохранённых чатов.
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
    /**
     * Режимы прав исполнителя (список даёт CLI). Пусто — исполнитель их не поддерживает
     * или ещё не опрошен: тогда чат просто не показывает выбор.
     */
    modesOf() {
      return (sessionModel) => this.modelOf(sessionModel).provider?.modes || [];
    },
    /**
     * Всё про модель чата одним вызовом: `{ id, model, provider }`. Пустое значение
     * и алиас разворачиваются как обычно (`resolveModelId` + `defaultModelId`).
     * Единая точка: и селект в чате, и строка списка чатов, и отправка спрашивают отсюда,
     * а не ищут модель по реестру каждый своим циклом.
     */
    modelOf() {
      return (sessionModel) => {
        const id = this.resolveModelId(sessionModel) || this.defaultModelId;
        for (const p of this.providers) {
          const model = (p.models || []).find((m) => m.id === id);
          if (model) return { id, model, provider: p };
        }
        return { id, model: null, provider: null };
      };
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
    // Потребление лимитов (прогрессбары в тултипе иконки исполнителя). Кэш минута;
    // force — после своих же изменений (доплата), когда ждать минуту нельзя.
    async loadUsage(force = false) {
      if (!force && Date.now() - usageAt < 60_000) return;
      usageAt = Date.now();
      try {
        const { usage } = await api.get('/api/providers/usage');
        this.usage = usage || {};
      } catch { /* эндпоинта нет / сервер молчит — баров просто нет */ }
    },
    /**
     * Declarative account action exposed by one provider adapter. requestId is
     * generated once per click so a provider can make irreversible calls idempotent.
     */
    async runUsageAction(providerId, actionId, payload = {}, requestId = '') {
      const operationId = requestId || globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        const r = await api.post(
          `/api/providers/${encodeURIComponent(providerId)}/usage-actions/${encodeURIComponent(actionId)}`,
          { requestId: operationId, payload },
        );
        if (r?.ok) await this.loadUsage(true);
        return r || { ok: false, error: 'сервер не ответил' };
      } catch (e) {
        return { ok: false, error: e.data?.message || e.message };
      }
    },
  },
});
