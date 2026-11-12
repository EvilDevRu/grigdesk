import { localeTranslator, translator } from '../../../shared/i18n/catalogs.ts';

import { uiLocalePort as uiLocale } from '../shared/uiLocalePort.ts';
// Реестр LLM-исполнителей (GET /api/providers): топбар рисует иконки доступных,
// схемы/маршруты смогут выбирать исполнителя по стабильному id из этого списка.
import { defineStore } from 'pinia';
import { toRaw } from 'vue';
import { classifyWriteError } from '../features/settings/contracts.ts';

import { isRecord } from '../../../shared/lib/objects.ts';
import type { ProviderEntry, ProviderModelEntry, ProviderSettingEntry }
  from '../../../shared/chat/providersContracts.ts';
import type { JsonValue } from '../../../shared/chat/providerSettingsContracts.ts';
import { isProvider, isUsageSnapshot, isUsageActionReply, type UsageEntry }
  from '../features/providers/contracts.ts';
import { api, failureText } from '../shared/apiClient.ts';
import { recordWebDiagnostic } from '../shared/webDiagnostics.ts';
import type { WebRegistryReason } from '../../../shared/web-log/webDiagnostics.ts';
import { familyModels } from '../../../shared/chat/modelFamily.ts';

const t = localeTranslator(uiLocale);

interface RegistryRead {
  promise: Promise<void>;
  version: number;
  refresh: boolean;
  wait: boolean;
  request: number;
}

interface RegistryLoadOptions {
  cached?: boolean;
  invalidate?: boolean;
  reason?: WebRegistryReason;
  wait?: boolean;
}

const registryReads = new WeakMap<object, RegistryRead>();
const registryStatuses = new WeakMap<object, { ok: boolean; message?: string }>();

type ProviderCliUpdate = (providerId: string) => Promise<void>;

let providerCliUpdate: ProviderCliUpdate | null = null;

/**
 * Окно установки подключает действие без обратного импорта UI из реестра.
 * Обработчик выбирает store текущей Pinia при вызове, не запоминает чужую сессию.
 */
export function connectProviderCliUpdate(action: ProviderCliUpdate): void {
  providerCliUpdate = action;
}

type RegistryProvider = Omit<ProviderEntry, 'settings'> & {
  settings?: Array<Omit<ProviderSettingEntry, 'value'> & { value: unknown }>;
};

type ModelSelection = unknown;
type ModelChoice = {
  id: string;
  provider: RegistryProvider | null;
  model: ProviderModelEntry | null;
};
type UpdateResult = {
  type: string;
  text: string;
  changed: boolean;
};

type McpState = {
  state?: string;
  error?: string;
  servers?: unknown[];
  loading: boolean;
};

export const useProvidersStore = defineStore('providers', {
  // showAllModels — настройка «показывать все модели, включая старые версии» (server prefs).
  // Держим её здесь же: список моделей приходит полным, тумблер только фильтрует показ.
  // mcp: id исполнителя → { state, servers[], error?, checkedAt, loading } — грузится лениво.
  // updating — id исполнителя, чей CLI ставится прямо сейчас (ход один на все окна кнопок),
  // updateResults — итог последней установки по исполнителю: { type, text, changed }.
  state: () => ({
    providers: [] as RegistryProvider[],
    usage: {} as Record<string, UsageEntry>,
    usageAt: 0,
    usageVersion: 0,
    usageRequest: 0,
    usageRecoveryAfter: {} as Record<string, number>,
    usageTransport: {
      status: 'idle',
      receivedAt: 0,
      error: '',
      connected: false,
      everConnected: false,
      deliveryStale: false,
    },
    mcp: {} as Record<string, McpState>,
    loaded: false,
    registryVersion: 0,
    registryRequest: 0,
    showAllModels: false,
    updating: '',
    updateResults: {} as Record<string, UpdateResult | null>,
    // Идёт принудительная проверка лимитов по кнопке: ход один на все всплывашки.
    usageRefreshing: false,
    usageRefreshingId: '',
    usageReloadPending: false,
    usageRefreshErrorId: '',
    usageRefreshError: '',
    usageAutoRefresh: null as boolean | null,
    usagePolicyRevision: -1,
  }),
  getters: {
    /**
     * Модель по умолчанию: сильнейшая из видимых в кратком списке (не `extra`) у доступного
     * исполнителя. Алиас `opus` дефолтом не берём — он скрыт и указывает на ту же модель,
     * что и первый пункт списка. Пока реестр не загружен — фоллбэк на алиас.
     */
    defaultModelId(state): string {
      for (const p of state.providers) {
        if (!p.available) {
          continue;
        }

        const m = (p.models || []).find((x) => !x.extra);

        if (m) {
          return m.id;
        }
      }

      return 'opus';
    },
    defaultModelRef(): { provider: string; model: string } | null {
      const current = this.modelOf(this.defaultModelId);

      return current.provider && current.model
        ? { provider: current.provider.id, model: current.model.id }
        : null;
    },
    /**
     * Модели исполнителя, которые видно в выборе. Правило одно на весь GrigDesk: краткий
     * список = только свежие версии, `extra` (старые версии) — под настройкой; выбранную
     * сейчас модель показываем всегда, иначе селект потеряет значение.
     */
    visibleModels: (state) => (provider: RegistryProvider | null, selectedId: string | null = null) =>
      (provider?.models || []).filter((m) => state.showAllModels || !m.extra || m.id === selectedId),
    /**
     * Сохранённый выбор → реальная модель. Алиас CLI (`opus`, `sonnet`, `haiku`) отдельным
     * пунктом не показывается: он привязан к модели, в которую резолвится (`aliases`).
     * Поэтому старый выбор «opus» и family policy вроде «sol» уходят как актуальная
     * конкретная модель установленного CLI, без ручных миграций сохранённых чатов.
     */
    resolveModelId: (state) => (id: string | null | undefined) => {
      if (!id) {
        return '';
      }

      for (const p of state.providers) {
        for (const m of p.models || []) {
          if (m.id === id
            || (m.modelRefAliases || []).includes(id)
            || (m.aliases || []).includes(id)) {
            return m.id;
          }
        }
      }
      for (const p of state.providers) {
        const m = familyModels(p.models || []).find((candidate) => candidate.family === id);

        if (m) {
          return m.id;
        }
      }

      return id; // реестр не загружен или модель незнакомая — отдаём как есть
    },
    /**
     * Режимы прав исполнителя (список даёт CLI). Пусто — исполнитель их не поддерживает
     * или ещё не опрошен: тогда чат просто не показывает выбор.
     */
    modesOf(): (selection: ModelSelection) => NonNullable<ProviderEntry['modes']> {
      return (sessionModel) => (this.modelOf(sessionModel).provider?.modes || []).map((mode) => ({
        ...mode,
        label: mode.labelKey ? translator.t(uiLocale.value, mode.labelKey, {}, mode.label) : mode.label,
        hint: mode.hintKey ? translator.t(uiLocale.value, mode.hintKey, {}, mode.hint) : mode.hint,
      }));
    },
    /**
     * Всё про модель чата одним вызовом: `{ id, model, provider }`. Пустое значение
     * и алиас разворачиваются как обычно (`resolveModelId` + `defaultModelId`).
     * Единая точка: и селект в чате, и строка списка чатов, и отправка спрашивают отсюда,
     * а не ищут модель по реестру каждый своим циклом.
     */
    modelOf(state: { providers: RegistryProvider[] }): (selection: ModelSelection) => ModelChoice {
      return (sessionModel) => {
        if (isRecord(sessionModel)) {
          const providerId = String(sessionModel.provider || '');
          const requestedId = String(sessionModel.model || '');
          const provider = state.providers.find((item) => item.id === providerId) || null;
          // Schema-2 modelRef — точный pin внутри конкретного provider-а. Удалённый
          // эквивалентный id (например прежний `[1m]`) можно свернуть только по отдельному
          // `modelRefAliases`; обычные CLI/family aliases здесь намеренно запрещены,
          // иначе versioned ref незаметно превратится в плавающий `opus`.
          const model = (provider?.models || []).find((item) => (
            item.id === requestedId || (item.modelRefAliases || []).includes(requestedId)
          )) || null;
  
        return {
          id: model?.id || requestedId,
          model,
          provider,
        };
        }

        const selected = typeof sessionModel === 'string' ? sessionModel : String(sessionModel || '');
        const id = this.resolveModelId(selected) || this.defaultModelId;

        for (const p of state.providers) {
          const model = (p.models || []).find((m) => m.id === id);

          if (model) {
            return {
              id,
              model,
              provider: p,
            };
          }
        }

        return {
          id,
          model: null,
          provider: null,
        };
      };
    },
  },
  actions: {
    /**
     * Общая ревизия упорядочивает выбор между prefs ACK и потоком квот разных окон.
     * Повтор допускается, более старый выбор и недоверенная форма отвергаются.
     */
    applyUsagePolicy(enabled: unknown, revision: unknown): boolean {
      if (typeof enabled !== 'boolean' || !Number.isSafeInteger(revision)
        || Number(revision) < 0 || Number(revision) < this.usagePolicyRevision) {
        return false;
      }

      this.usagePolicyRevision = Number(revision);
      this.usageAutoRefresh = enabled;

      return true;
    },

    /**
     * Читатели одной версии разделяют GET; монтирование использует готовый снимок.
     * SSE/credentials инвалидируют летящий ответ, а явный refresh сильнее обычного чтения.
     */
    load(refresh = false, {
      cached = false, invalidate = false, reason = 'other', wait = false,
    }: RegistryLoadOptions = {}): Promise<void> {
      const key = toRaw(this);
      const previousCount = this.providers.length;
      const started = performance.now();

      if (invalidate) {
        this.registryVersion += 1;
      }

      const version = this.registryVersion;
      const previous = registryReads.get(key);
      const trace = (outcome: 'start' | 'joined' | 'cached' | 'applied' | 'discarded' | 'invalid' | 'failed',
        request: number, count?: number) => recordWebDiagnostic('providers.registry', {
        reason,
        outcome,
        request,
        refresh,
        previous: previousCount,
        ms: Math.max(0, performance.now() - started),
        ...(count === undefined ? {} : { count }),
      });

      if (previous?.version === version && (!refresh || previous.refresh)
        && (!wait || previous.wait || previous.refresh)) {
        trace('joined', previous.request);

        return previous.promise;
      }
      if (cached && this.loaded && !refresh && !invalidate && !wait) {
        trace('cached', this.registryRequest, previousCount);

        return Promise.resolve();
      }

      const request = ++this.registryRequest;

      trace('start', request);

      const pending = (async () => {
        try {
          const query = refresh ? '?refresh=1' : wait ? '?wait=1' : '';
          const reply = await api.get(`/api/providers${query}`);

          if (!isRecord(reply) || (reply.providers != null
            && (!Array.isArray(reply.providers) || !reply.providers.every(isProvider)))) {
            trace('invalid', request);
            recordWebDiagnostic('state.anomaly', {
              store: 'providers',
              action: 'load',
              kind: 'invalid-snapshot',
              request,
              previous: previousCount,
            });

            throw new Error(t('settings.providerRegistryFailure'));
          }

          const providers = reply.providers;
          const showAllModels = reply.showAllModels;

          if (request !== this.registryRequest || version !== this.registryVersion) {
            trace('discarded', request, providers?.length ?? 0);

            return;
          }

          this.providers = providers || [];
          this.showAllModels = !!showAllModels;
          registryStatuses.set(key, { ok: true });
          trace('applied', request, this.providers.length);

          if (previousCount > 0 && this.providers.length === 0) {
            recordWebDiagnostic('state.anomaly', {
              store: 'providers',
              action: 'load',
              kind: 'empty-snapshot',
              request,
              previous: previousCount,
              count: 0,
            });
          }
        } catch (error) {
          trace('failed', request);

          if (request === this.registryRequest && version === this.registryVersion) {
            registryStatuses.set(key, {
              ok: false,
              message: failureText(error) || t('settings.providerRegistryFailure'),
            });
          }
        }

        if (request === this.registryRequest && version === this.registryVersion) {
          this.loaded = true;
        }
      })().finally(() => {
        if (registryReads.get(key)?.promise === pending) {
          registryReads.delete(key);
        }
      });

      registryReads.set(key, {
        promise: pending,
        version,
        refresh,
        wait,
        request,
      });

      return pending;
    },
    /**
     * Отсутствие модели в холодном HTTP-снимке ещё не означает её удаления.
     * Строгое чтение ждёт общий серверный сбор; инвалидация требует новой проверки.
     */
    async ensureModel(selection: ModelSelection): Promise<void> {
      const current = this.modelOf(selection);

      if (current.provider && current.model) {
        return;
      }

      let version;
      let status;

      do {
        version = this.registryVersion;
        await this.load(false, { wait: true });
        status = await this.whenRegistryReady();
      } while (version !== this.registryVersion);

      if (!status.ok) {
        throw new Error(status.message || t('settings.providerRegistryFailure'));
      }
    },
    /**
     * Координатор настроек ждёт актуальное чтение реестра после записи ключа.
     * Сам ACK доменного store остаётся быстрым и не ждёт usage-проверку.
     */
    async whenRegistryReady(): Promise<{ ok: boolean; message?: string }> {
      const key = toRaw(this);
      let pending;

      do {
        pending = registryReads.get(key);
        await pending?.promise;
      } while (pending !== registryReads.get(key));

      return registryStatuses.get(key) || { ok: true };
    },
    /**
     * Сбрасывает счёт изменённого аккаунта сразу при ACK или общем SSE-событии.
     * Новый GET обходит throttle, а сетевой отказ относится к проверке, не к записи ключа.
     */
    invalidateCredentials(providerId: string): Promise<[void, void]> {
      const next = { ...this.usage };

      delete next[providerId];
      delete this.usageRecoveryAfter[providerId];
      this.usage = next;
      this.usageVersion += 1;
      this.usageRequest += 1;
      this.registryVersion += 1;
      this.registryRequest += 1;
      this.usageAt = 0;
      this.usageTransport.error = '';

      if (this.usageRefreshErrorId === providerId) {
        this.usageRefreshErrorId = '';
        this.usageRefreshError = '';
      }

      return Promise.all([this.load(false, { reason: 'credentials' }), this.loadUsage(true)]);
    },
    /**
     * Использует существующий минутный GET; компоненты читают единый снимок.
     * Транспортный отказ завершается явно и не означает разлогин у исполнителя.
     */
    async loadUsage(force = false, cached = false) {
      if (this.usageRefreshing) {
        this.usageReloadPending ||= force;

        return;
      }

      if (!force && Date.now() - this.usageAt < 60_000) {
        return;
      }

      this.usageAt = Date.now();
      await this._requestUsage(false, undefined, cached);
    },
    /**
     * SSE и HTTP конкурируют за один снимок. Событие либо более новый запрос
     * инвалидируют результат уже летящего GET/refresh вместе с его ошибкой.
     */
    async _requestUsage(refresh: boolean, providerId?: string, cached = false) {
      const request = ++this.usageRequest;
      const version = this.usageVersion;

      this.usageTransport.status = 'loading';

      try {
        const response = refresh
          ? await api.post('/api/providers/usage/refresh', { providerId })
          : await api.get(cached ? '/api/providers/usage?cached=1' : '/api/providers/usage');

        if (request !== this.usageRequest || version !== this.usageVersion) {
          return;
        }
        if (!this.applyUsage(isRecord(response) ? response.usage : undefined,
          isRecord(response) ? response.autoRefresh : undefined,
          isRecord(response) ? response.autoRefreshRevision : undefined)) {
          throw new Error(t('settings.usageSnapshotMissing'));
        }
      } catch (error) {
        if (refresh && this.usageRefreshingId === providerId) {
          this.usageRefreshErrorId = providerId ?? '';
          this.usageRefreshError = failureText(error) || t('settings.usageLoadFailure');
        }

        if (request !== this.usageRequest || version !== this.usageVersion) {
          return;
        }

        this.usageTransport.status = 'error';
        this.usageTransport.error = failureText(error) || t('settings.usageLoadFailure');
        this.usageTransport.deliveryStale = this.usageTransport.receivedAt > 0;
        this.markUsageRecovery();
      }
    },
    /**
     * Принятый снимок снимает ошибку доставки и сдвигает троттл обычного GET.
     * При разорванном SSE HTTP обновляет числа, сохраняя недоступность живого обновления.
     */
    applyUsage(usage: unknown, autoRefresh?: unknown, policyRevision?: unknown) {
      if (!isUsageSnapshot(usage)) {
        return false;
      }

      if (typeof autoRefresh === 'boolean' && Number.isSafeInteger(policyRevision)
        && Number(policyRevision) < this.usagePolicyRevision) {
        return true;
      }

      this.applyUsagePolicy(autoRefresh, policyRevision);

      const next: Record<string, UsageEntry> = {};

      for (const [id, entry] of Object.entries(usage)) {
        const boundary = this.usageRecoveryAfter[id];
        const recovered = boundary !== undefined && entry.state === 'ok' && !entry.stale
          && typeof entry.lastSuccessfulAt === 'number' && entry.lastSuccessfulAt > boundary;

        if (recovered && (!this.usageTransport.everConnected || this.usageTransport.connected)) {
          delete this.usageRecoveryAfter[id];
        }

        next[id] = this.usageRecoveryAfter[id] === undefined ? entry : { ...entry, stale: true };
      }

      this.usage = next;
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
     * Запоминает последний замер до разрыва: повтор кэша не подтверждает восстановление.
     * Старые исполнители без metadata сохраняют прежний контракт доставки.
     */
    markUsageRecovery() {
      for (const [id, entry] of Object.entries(this.usage)) {
        if (Object.hasOwn(entry, 'lastSuccessfulAt')) {
          this.usageRecoveryAfter[id] = Math.max(this.usageRecoveryAfter[id] || 0,
            entry.lastSuccessfulAt || 0);
        }
      }
    },
    /**
     * Потеря общего SSE помечает доставку устаревшей для всех читателей.
     * Сам reconnect метку не снимает: нужен новый принятый снимок usage.
     */
    noteUsageConnection(connected: boolean) {
      const transport = this.usageTransport;
      const reconnect = connected && transport.everConnected && !transport.connected;

      if (transport.everConnected && transport.connected && !connected) {
        transport.deliveryStale = true;
        this.markUsageRecovery();
      }

      transport.connected = connected;
      transport.everConnected ||= connected;

      if (reconnect) {
        this.usageVersion += 1;
        this.usageRequest += 1;
        this.registryVersion += 1;
        this.registryRequest += 1;
        void this.load(false, { reason: 'reconnect' });
        void this.loadUsage(true);
      }
    },
    /**
     * Один ручной запрос окна принадлежит выбранному исполнителю и общему серверу.
     * Соседние таймеры не вытесняют ответ; все выходы освобождают состояние кнопки.
     */
    async refreshUsage(providerId: string) {
      if (this.usageRefreshing || !providerId) {
        return;
      }

      this.usageRefreshing = true;
      this.usageRefreshingId = providerId;
      this.usageRefreshErrorId = '';
      this.usageRefreshError = '';

      try {
        await this._requestUsage(true, providerId);
      } finally {
        this.usageRefreshing = false;
        this.usageRefreshingId = '';

        if (this.usageReloadPending) {
          this.usageReloadPending = false;
          await this.loadUsage(true, true);
        }
      }
    },
    /**
     * Обе поверхности запускают одну подтверждённую серверную операцию.
     * Занятость и итог приходят из её снимка, а не из длительности HTTP-запроса.
     */
    async updateCli(providerId: string): Promise<void> {
      await providerCliUpdate?.(providerId);
    },
    /**
     * Своя настройка исполнителя (тумблер в его плашке). Значение применяем сразу,
     * чтобы тумблер не «отставал», и откатываем, если сервер не принял: схему настроек
     * объявляет исполнитель, фронт про смысл ключа ничего не знает.
     */
    async saveSetting(providerId: string, settingId: string, value: JsonValue, confirmed?: boolean) {
      const p = this.providers.find((x) => x.id === providerId);
      const s = (p?.settings || []).find((x) => x.id === settingId);

      if (!p || !s) {
        return {
          ok: false,
          outcome: 'failed',
          error: t('settings.providerUnknownSetting'),
        };
      }

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

        if (!isRecord(r) || r.ok !== true) {
          s.value = before;

          return {
            ok: false,
            outcome: isRecord(r) && r.ok === false ? 'failed' : 'unknown',
            error: isRecord(r) && typeof r.message === 'string'
              ? r.message : t('settings.providerValueRejected'),
          };
        }

        const checked = { ...p, settings: r.settings };

        if (!isProvider(checked)) {
          throw new Error(t('settings.providerValueRejected'));
        }
        if (checked.settings) {
          p.settings = checked.settings;
        }

        const accepted = (checked.settings || []).find((setting) => setting.id === settingId);

        return { ok: true, ...(accepted && Object.hasOwn(accepted, 'value')
          ? { serverValue: accepted.value } : {}) };
      } catch (e) {
        s.value = before;

        const result = classifyWriteError(e, uiLocale);

        return {
          ok: false,
          outcome: result.outcome,
          ...(result.status === undefined ? {} : { status: result.status }),
          error: failureText(e),
        };
      }
    },
    /**
     * Ключи доступа исполнителя (окно «Ключи доступа»): values — имя переменной → значение
     * или null для удаления. Сервер пишет их в корневой .env; каталог моделей он перечитывает
     * в фоне и сообщает о нём событием providers-update. Несекретные choice из ACK
     * возвращаются координатору, но не перезаписывают более новый снимок всего store.
     */
    async saveCredentials(providerId: string, values: Record<string, string | null>) {
      try {
        const r = await api.post(
          `/api/providers/${encodeURIComponent(providerId)}/credentials`,
          { values },
        );

        if (!isRecord(r) || r.ok !== true) {
          return {
            ok: false,
            outcome: isRecord(r) && r.ok === false ? 'failed' : 'unknown',
            error: isRecord(r) && typeof r.message === 'string'
              ? r.message : t('settings.providerCredentialsRejected'),
          };
        }

        void this.invalidateCredentials(providerId);

        const choices = Array.isArray(r.credentials) ? r.credentials.filter((field) => isRecord(field)
          && field.kind === 'choice' && typeof field.env === 'string'
          && (typeof field.value === 'string' || field.value === null)) : [];
        const savedChoices: Record<string, string | null> = Object.fromEntries(
          choices.map((field) => [field.env, field.value]),
        );

        return { ok: true, ...choices.length ? { savedChoices } : {} };
      } catch (e) {
        const result = classifyWriteError(e, uiLocale);

        return {
          ok: false,
          outcome: result.outcome,
          ...(result.status === undefined ? {} : { status: result.status }),
          error: failureText(e),
        };
      }
    },
    /**
     * MCP-серверы исполнителя (блок в его плашке настроек). Запрос отдельный и
     * ленивый: адаптер может проверять соединения или читать несколько конфигов,
     * поэтому дёргается по открытию вкладки и вручную, а не вместе с реестром.
     */
    async loadMcp(providerId: string, refresh = false) {
      const id = String(providerId);

      this.mcp = { ...this.mcp, [id]: { ...(this.mcp[id] || {}), loading: true } };

      try {
        const r = await api.get(`/api/providers/${encodeURIComponent(id)}/mcp${refresh ? '?refresh=1' : ''}`);

        if (!isRecord(r)) {
          throw new Error(t('settings.providerNoResponse'));
        }

        this.mcp = { ...this.mcp, [id]: { ...r, loading: false } };

        return r;
      } catch (e) {
        const data = {
          state: 'error',
          error: failureText(e),
          servers: [],
          loading: false,
        };

        this.mcp = { ...this.mcp, [id]: data };

        return data;
      }
    },
    /**
     * Действие объявляет адаптер исполнителя, клиент не меняет его payload.
     * Идентификатор создаётся один раз для идемпотентного повторения записи.
     */
    async runUsageAction(providerId: string, actionId: string,
      payload: Record<string, unknown> = {}, requestId = '') {
      const operationId = requestId || globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      try {
        const r = await api.post(
          `/api/providers/${encodeURIComponent(providerId)}/usage-actions/${encodeURIComponent(actionId)}`,
          { requestId: operationId, payload },
        );

        if (isRecord(r) && r.ok) {
          await this.loadUsage(true);
        }

        if (!isUsageActionReply(r)) {
          return { ok: false, error: t('settings.providerNoResponse') };
        }

        return r;
      } catch (e) {
        return { ok: false, error: failureText(e) };
      }
    },
  },
});
