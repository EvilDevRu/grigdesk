// Реестр LLM-исполнителей (GET /api/providers): топбар рисует иконки доступных,
// схемы/маршруты смогут выбирать исполнителя по стабильному id из этого списка.
import { defineStore } from 'pinia';
import { api } from '../shared/apiClient.ts';
import { familyModels } from '../shared/modelFamily.ts';

export const useProvidersStore = defineStore('providers', {
  // showAllModels — настройка «показывать все модели, включая старые версии» (server prefs).
  // Держим её здесь же: список моделей приходит полным, тумблер только фильтрует показ.
  // mcp: id исполнителя → { state, servers[], error?, checkedAt, loading } — грузится лениво.
  // updating — id исполнителя, чей CLI ставится прямо сейчас (ход один на все окна кнопок),
  // updateResults — итог последней установки по исполнителю: { type, text, changed }.
  state: () => ({
    providers: [],
    usage: {},
    usageAt: 0,
    usageVersion: 0,
    usageRequest: 0,
    usageTransport: {
      status: 'idle',
      receivedAt: 0,
      error: '',
      connected: false,
      everConnected: false,
      deliveryStale: false,
    },
    mcp: {},
    loaded: false,
    showAllModels: false,
    updating: '',
    updateResults: {},
    // Идёт принудительная проверка лимитов по кнопке: ход один на все всплывашки.
    usageRefreshing: false,
  }),
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
    defaultModelRef() {
      const current = this.modelOf(this.defaultModelId);
      return current.provider && current.model
        ? { provider: current.provider.id, model: current.model.id }
        : null;
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
     * Поэтому старый выбор «opus» и family policy вроде «sol» уходят как актуальная
     * конкретная модель установленного CLI, без ручных миграций сохранённых чатов.
     */
    resolveModelId: (state) => (id) => {
      if (!id) return '';
      for (const p of state.providers) {
        for (const m of p.models || []) {
          if (m.id === id
            || (m.modelRefAliases || []).includes(id)
            || (m.aliases || []).includes(id)) return m.id;
        }
      }
      for (const p of state.providers) {
        const m = familyModels(p.models || []).find((candidate) => candidate.family === id);
        if (m) return m.id;
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
        if (sessionModel && typeof sessionModel === 'object') {
          const providerId = String(sessionModel.provider || '');
          const requestedId = String(sessionModel.model || '');
          const provider = this.providers.find((item) => item.id === providerId) || null;
          // Schema-2 modelRef — точный pin внутри конкретного provider-а. Удалённый
          // эквивалентный id (например прежний `[1m]`) можно свернуть только по отдельному
          // `modelRefAliases`; обычные CLI/family aliases здесь намеренно запрещены,
          // иначе versioned ref незаметно превратится в плавающий `opus`.
          const model = (provider?.models || []).find((item) => (
            item.id === requestedId || (item.modelRefAliases || []).includes(requestedId)
          )) || null;
          return { id: model?.id || requestedId, model, provider };
        }
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
    /**
     * Использует существующий минутный GET; компоненты читают единый снимок.
     * Транспортный отказ завершается явно и не означает разлогин у исполнителя.
     */
    async loadUsage(force = false) {
      if (!force && Date.now() - this.usageAt < 60_000) {
        return;
      }

      this.usageAt = Date.now();
      await this._requestUsage(false);
    },
    /**
     * SSE и HTTP конкурируют за один снимок. Событие либо более новый запрос
     * инвалидируют результат уже летящего GET/refresh вместе с его ошибкой.
     */
    async _requestUsage(refresh) {
      const request = ++this.usageRequest;
      const version = this.usageVersion;

      this.usageTransport.status = 'loading';

      try {
        const response = refresh
          ? await api.post('/api/providers/usage/refresh')
          : await api.get('/api/providers/usage');

        if (request !== this.usageRequest || version !== this.usageVersion) {
          return;
        }
        if (!this.applyUsage(response?.usage)) {
          throw new Error('Сервер не вернул снимок лимитов.');
        }
      } catch (error) {
        if (request !== this.usageRequest || version !== this.usageVersion) {
          return;
        }

        this.usageTransport.status = 'error';
        this.usageTransport.error = error?.message || 'Не удалось получить лимиты от Cockpit.';
        this.usageTransport.deliveryStale = this.usageTransport.receivedAt > 0;
      }
    },
    /**
     * Принятый снимок снимает ошибку доставки и сдвигает троттл обычного GET.
     * При разорванном SSE HTTP обновляет числа, сохраняя недоступность живого обновления.
     */
    applyUsage(usage) {
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
        return false;
      }

      this.usage = usage;
      this.usageAt = Date.now();
      this.usageVersion += 1;
      this.usageTransport.status = 'success';
      this.usageTransport.receivedAt = this.usageAt;
      this.usageTransport.error = '';
      this.usageTransport.deliveryStale = this.usageTransport.everConnected
        && !this.usageTransport.connected;

      return true;
    },
    /**
     * Потеря общего SSE помечает доставку устаревшей для всех читателей.
     * Сам reconnect метку не снимает: нужен новый принятый снимок usage.
     */
    noteUsageConnection(connected) {
      const transport = this.usageTransport;

      if (transport.everConnected && transport.connected && !connected) {
        transport.deliveryStale = true;
      }

      transport.connected = connected;
      transport.everConnected ||= connected;
    },
    /**
     * Проверка по кнопке остаётся общей для всех всплывашек.
     * Защита от позднего ответа совпадает с обычным GET, новый опрос не появляется.
     */
    async refreshUsage() {
      if (this.usageRefreshing) {
        return;
      }

      this.usageRefreshing = true;

      try {
        await this._requestUsage(true);
      } finally {
        this.usageRefreshing = false;
      }
    },
    /**
     * Установка новой версии CLI исполнителя. Живёт в сторе, а не во вьюхе: жмут и в
     * плашке настроек, и во всплывашке топбара, а ход у операции один — пока npm ставит,
     * второй кнопке нельзя показывать «можно жать». Версия CLI задаёт набор моделей,
     * поэтому по итогу реестр перечитывается принудительно.
     */
    async updateCli(providerId) {
      if (this.updating) return { ok: false, error: 'другой CLI уже обновляется' };

      this.updating = providerId;
      this.updateResults = { ...this.updateResults, [providerId]: null };

      let result;

      try {
        const r = await api.post(`/api/providers/${encodeURIComponent(providerId)}/update`, {});

        result = r.changed
          ? {
            type: 'ok',
            text: `Обновлён: ${r.before || '?'} → ${r.after}. Список моделей пересобран.`,
            changed: true,
          }
          : {
            type: r.ok ? 'ok' : 'err',
            text: r.ok
              ? `Уже последняя версия (${r.after || r.before}).`
              : `Не получилось: ${(r.output || '').slice(-300)}`,
            changed: false,
          };
        this.updateResults = { ...this.updateResults, [providerId]: result };
        await this.load(true);
      } catch (e) {
        result = { type: 'err', text: e.message, changed: false };
        this.updateResults = { ...this.updateResults, [providerId]: result };
      } finally {
        this.updating = '';
      }

      return result;
    },
    /**
     * Своя настройка исполнителя (тумблер в его плашке). Значение применяем сразу,
     * чтобы тумблер не «отставал», и откатываем, если сервер не принял: схему настроек
     * объявляет исполнитель, фронт про смысл ключа ничего не знает.
     */
    async saveSetting(providerId, settingId, value, confirmed) {
      const p = this.providers.find((x) => x.id === providerId);
      const s = (p?.settings || []).find((x) => x.id === settingId);
      if (!s) return { ok: false, error: 'настройка не объявлена исполнителем' };
      const before = s.value;
      s.value = value;
      try {
        const body = {
          settingId,
          value,
          ...(confirmed === true ? { confirmed: true } : {}),
        };
        const r = await api.post(
          `/api/providers/${encodeURIComponent(providerId)}/settings`,
          body,
        );
        if (!r?.ok) { s.value = before; return { ok: false, error: r?.message || 'сервер не принял значение' }; }
        if (r.settings) p.settings = r.settings;
        return { ok: true };
      } catch (e) {
        s.value = before;
        return { ok: false, error: e.data?.message || e.message };
      }
    },
    /**
     * MCP-серверы исполнителя (блок в его плашке настроек). Запрос отдельный и
     * ленивый: адаптер может проверять соединения или читать несколько конфигов,
     * поэтому дёргается по открытию вкладки и вручную, а не вместе с реестром.
     */
    async loadMcp(providerId, refresh = false) {
      const id = String(providerId);
      this.mcp = { ...this.mcp, [id]: { ...(this.mcp[id] || {}), loading: true } };
      try {
        const r = await api.get(`/api/providers/${encodeURIComponent(id)}/mcp${refresh ? '?refresh=1' : ''}`);
        this.mcp = { ...this.mcp, [id]: { ...r, loading: false } };
        return r;
      } catch (e) {
        const data = { state: 'error', error: e.data?.message || e.message, servers: [], loading: false };
        this.mcp = { ...this.mcp, [id]: data };
        return data;
      }
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
