// Прогноз лимитов исполнителей: «хватит ли окна до сброса» и «когда сбрасывали».
//
// Системный плагин `usage-forecast`: тумблер и настройки читаются на каждом шаге через
// `pluginEnabled`/`pluginSettings`, поэтому действуют без рестарта. Выключенный плагин
// инертен: не пишет ряды, не ходит ни к вендору, ни за внешним сигналом, а маршрут
// отвечает `404 plugin_disabled`, как у прочих системных плагинов.
//
// Модуль ничего не спрашивает у вендоров сам: он слушает тот же SSE `providers-usage`,
// который фоновый тик модуля providers шлёт окнам, копит из него ряды и отдаёт
// `GET /api/usage-forecast` плюс своё событие `usage-forecast`. К providers он не
// привязан импортом — выпиливается вместе со своей папкой.
//
// Тик providers молчит при пустом зале, а прогнозу замеры нужны и без окон: своим
// таймером модуль зовёт `fastify.refreshProvidersUsage`, когда окон нет. Хук
// необязателен — без него ряды копятся только при открытой вкладке.
//
// Своё нажатие «Использовать сброс лимита» модуль узнаёт по ответу на его маршрут:
// hook `onResponse` видит URL и код, а сам маршрут об этом модуле не знает.
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

import type { UsageForecastSnapshot } from '../../../../shared/usageForecastContracts.ts';
import type { CodexResetSource } from '../../lib/usage-forecast/codexResetSource.ts';
import { forecastAll, ingestUsage, type ForecastState } from '../../lib/usage-forecast/forecast.ts';
import { readForecastState, writeForecastState } from '../../lib/usage-forecast/store.ts';

export const USAGE_FORECAST_PLUGIN_ID = 'usage-forecast';

export interface UsageForecastModuleOptions {
  filePath: string;
  // Внешний сигнал о сбросах; null — раздел живёт только своими данными.
  external?: CodexResetSource | null;
  externalTickMs?: number;
  // Шаг фоновых замеров без окон, если настройка плагина его не назвала; 0 — не замерять.
  sampleTickMs?: number;
  now?: () => number;
}

// Настройки плагина в том виде, в каком их читает модуль; форму объявляет манифест.
interface ForecastSettings {
  providers: Set<string> | null;
  externalSignal: boolean;
  sampleTickMs: number;
}

// Опрос внешнего источника — по его же TTL; чаще он всё равно отдаст кэш.
const EXTERNAL_TICK_MS = 60 * 60_000;
// Таймер фона идёт раз в минуту, а шаг замера задаёт настройка: так её смена действует
// без пересоздания таймера. Минута — грубее не надо, точнее незачем.
const SAMPLE_CHECK_MS = 60_000;
// Замер без окон — раз в четверть часа: сброс и ночной расход этим шагом видны, а
// походов к вендору впятеро меньше, чем при открытой вкладке.
const SAMPLE_TICK_MS = 15 * 60_000;
// Сколько последних сбросов уезжает окну. Не дюжина: 5-часовые окна истекают по пять
// раз в сутки на исполнителя, и короткий хвост вытеснил бы редкий сброс вендора.
const RESETS_IN_SNAPSHOT = 60;
const OWN_RESET_ROUTE = /^\/api\/providers\/([^/?]+)\/usage-actions\/consume-rate-limit-reset(?:[?#]|$)/;

async function usageForecastModule(
  fastify: FastifyInstance,
  opts: UsageForecastModuleOptions,
): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const external = opts.external ?? null;
  const loaded = readForecastState(opts.filePath);
  const ownActions = new Map<string, number>();

  let state: ForecastState = loaded.state;
  let lastSampleAt = 0;

  if (loaded.warning) {
    fastify.log.warn(loaded.warning);
  }

  // Без реестра плагинов (тесты, урезанная сборка) модуль считается включённым, а
  // настройки — умолчаниями манифеста.
  function enabled(): boolean {
    return typeof fastify.pluginEnabled === 'function'
      ? fastify.pluginEnabled(USAGE_FORECAST_PLUGIN_ID)
      : true;
  }

  /**
   * Настройки на момент вызова: область по исполнителям (пусто — все), внешний сигнал и
   * шаг фона. Значения недоверенные — приводятся здесь, а не там, где используются.
   */
  function settings(): ForecastSettings {
    const raw = (fastify.pluginSettings?.(USAGE_FORECAST_PLUGIN_ID) || {}) as Record<string, unknown>;
    const providers = Array.isArray(raw.providers)
      ? raw.providers.filter((id): id is string => typeof id === 'string' && Boolean(id))
      : [];
    const minutes = Number(raw.sampleTickMinutes);

    return {
      providers: providers.length ? new Set(providers) : null,
      externalSignal: raw.externalSignal !== false,
      sampleTickMs: Number.isFinite(minutes) && minutes >= 0
        ? minutes * 60_000
        : opts.sampleTickMs ?? SAMPLE_TICK_MS,
    };
  }

  function snapshot(): UsageForecastSnapshot {
    const at = now();
    const current = settings();
    const signal = external && current.externalSignal ? external.peek(at) : null;

    return {
      generatedAt: new Date(at).toISOString(),
      bars: forecastAll(state, { now: at })
        .filter((bar) => !current.providers || current.providers.has(bar.providerId)),
      resets: state.resets
        .filter((reset) => !current.providers || current.providers.has(reset.providerId))
        .slice(-RESETS_IN_SNAPSHOT)
        .reverse(),
      external: signal && (!current.providers || current.providers.has(signal.providerId)) ? signal : null,
    };
  }

  function broadcast(): void {
    fastify.sse?.broadcast?.('usage-forecast', snapshot());
  }

  /**
   * Приём снимка лимитов с фонового тика: ряд удлиняется, сбросы попадают в журнал,
   * состояние уезжает на диск. Исполнители вне области не замеряются вовсе — их ряды
   * не копятся впустую. Отказ записи не роняет приём — ряды живут в памяти, а причина
   * уходит в журнал сервера.
   */
  function ingest(usage: unknown): void {
    if (!enabled() || !usage || typeof usage !== 'object') {
      return;
    }

    const scope = settings().providers;
    const scoped = Object.fromEntries(Object.entries(usage as Record<string, unknown>)
      .filter(([providerId]) => !scope || scope.has(providerId)));
    const result = ingestUsage(state, scoped, { now: now(), ownActions });

    state = result.state;

    for (const reset of result.resets) {
      fastify.log.info({ reset }, 'замечен сброс окна лимита');
    }

    try {
      writeForecastState(opts.filePath, state);
    } catch (error) {
      fastify.log.warn({ err: error }, 'состояние прогноза лимитов не сохранено');
    }

    broadcast();
  }

  const unsubscribe = fastify.sse?.subscribe?.((name, payload) => {
    if (name === 'providers-usage') {
      ingest((payload as { usage?: unknown } | null)?.usage);
    }
  }) ?? null;

  fastify.addHook('onResponse', async (request, reply) => {
    const providerId = request.url.match(OWN_RESET_ROUTE)?.[1];

    if (providerId && request.method === 'POST' && reply.statusCode < 300) {
      ownActions.set(decodeURIComponent(providerId), now());
    }
  });

  /**
   * Внешний источник принадлежит исполнителю из его снимка: область проверяется
   * до чтения, чтобы скрытый сигнал не продолжал расходовать сеть в фоне.
   */
  async function refreshExternal(): Promise<void> {
    if (!external || !enabled()) {
      return;
    }

    const current = settings();

    if (!current.externalSignal) {
      return;
    }

    const signal = external.peek(now());

    if (current.providers && !current.providers.has(signal.providerId)) {
      return;
    }

    const before = JSON.stringify(signal);
    const after = JSON.stringify(await external.read(now()));

    if (enabled() && before !== after) {
      broadcast();
    }
  }

  const externalTimer = external
    ? setInterval(() => {
      refreshExternal().catch((error: unknown) => {
        fastify.log.warn({ err: error }, 'внешний сигнал о сбросах не обновился');
      });
    }, opts.externalTickMs ?? EXTERNAL_TICK_MS)
    : null;

  externalTimer?.unref?.();

  /**
   * Замер без окон. При открытом окне снимок и так приносит тик providers, а хук
   * с устаревшим снимком не расходится: он сам пропускает свежий. Поэтому здесь
   * только проверка зала и шага — второго пути к вендору нет.
   */
  async function sampleWithoutWindows(): Promise<void> {
    const stepMs = settings().sampleTickMs;
    const at = now();

    if (!enabled() || stepMs <= 0 || at - lastSampleAt < stepMs) {
      return;
    }
    if ((fastify.sse?.clientCount?.() ?? 0) > 0 || typeof fastify.refreshProvidersUsage !== 'function') {
      return;
    }

    lastSampleAt = at;
    await fastify.refreshProvidersUsage();
  }

  const sampleTimer = setInterval(() => {
    sampleWithoutWindows().catch((error: unknown) => {
      fastify.log.warn({ err: error }, 'фоновый замер лимитов для прогноза не удался');
    });
  }, Math.min(SAMPLE_CHECK_MS, opts.sampleTickMs || SAMPLE_CHECK_MS));

  sampleTimer.unref?.();

  fastify.addHook('onReady', async () => {
    // Первый поход за внешним сигналом — фоном: старт сервера сеть не ждёт.
    refreshExternal().catch(() => {});
  });

  fastify.addHook('onClose', async () => {
    unsubscribe?.();

    if (externalTimer) {
      clearInterval(externalTimer);
    }
    clearInterval(sampleTimer);
  });

  fastify.get('/api/usage-forecast', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');

    if (!enabled()) {
      return reply.code(404).send({ error: 'plugin_disabled' });
    }

    return snapshot();
  });
}

export default fp(usageForecastModule, { name: 'module-usage-forecast' });
