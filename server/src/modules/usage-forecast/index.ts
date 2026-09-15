// Прогноз лимитов исполнителей: «хватит ли окна до сброса» и «когда сбрасывали».
//
// Модуль ничего не спрашивает у вендоров сам: он слушает тот же SSE `providers-usage`,
// который фоновый тик модуля providers шлёт окнам, копит из него ряды и отдаёт
// `GET /api/usage-forecast` плюс своё событие `usage-forecast`. К providers он не
// привязан импортом — выпиливается вместе со своей папкой.
//
// Тик providers молчит при пустом зале, а прогнозу замеры нужны и ночью: своим редким
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

export interface UsageForecastModuleOptions {
  filePath: string;
  // Внешний сигнал о сбросах; null — раздел живёт только своими данными.
  external?: CodexResetSource | null;
  externalTickMs?: number;
  // Шаг фоновых замеров без окон; 0 — не замерять без окон вовсе.
  sampleTickMs?: number;
  now?: () => number;
}

// Опрос внешнего источника — по его же TTL; чаще он всё равно отдаст кэш.
const EXTERNAL_TICK_MS = 60 * 60_000;
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

  if (loaded.warning) {
    fastify.log.warn(loaded.warning);
  }

  function snapshot(): UsageForecastSnapshot {
    const at = now();

    return {
      generatedAt: new Date(at).toISOString(),
      bars: forecastAll(state, { now: at }),
      resets: state.resets.slice(-RESETS_IN_SNAPSHOT).reverse(),
      external: external ? external.peek(at) : null,
    };
  }

  function broadcast(): void {
    fastify.sse?.broadcast?.('usage-forecast', snapshot());
  }

  /**
   * Приём снимка лимитов с фонового тика: ряд удлиняется, сбросы попадают в журнал,
   * состояние уезжает на диск. Отказ записи не роняет приём — ряды живут в памяти,
   * а причина уходит в журнал сервера.
   */
  function ingest(usage: unknown): void {
    if (!usage || typeof usage !== 'object') {
      return;
    }

    const result = ingestUsage(state, usage as Record<string, unknown>, { now: now(), ownActions });

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

  async function refreshExternal(): Promise<void> {
    if (!external) {
      return;
    }

    const before = JSON.stringify(external.peek(now()));
    const after = JSON.stringify(await external.read(now()));

    if (before !== after) {
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
   * только проверка зала — второго пути к вендору нет.
   */
  async function sampleWithoutWindows(): Promise<void> {
    if ((fastify.sse?.clientCount?.() ?? 0) > 0 || typeof fastify.refreshProvidersUsage !== 'function') {
      return;
    }

    await fastify.refreshProvidersUsage();
  }

  const sampleTickMs = opts.sampleTickMs ?? SAMPLE_TICK_MS;
  const sampleTimer = sampleTickMs > 0
    ? setInterval(() => {
      sampleWithoutWindows().catch((error: unknown) => {
        fastify.log.warn({ err: error }, 'фоновый замер лимитов для прогноза не удался');
      });
    }, sampleTickMs)
    : null;

  sampleTimer?.unref?.();

  fastify.addHook('onReady', async () => {
    // Первый поход за внешним сигналом — фоном: старт сервера сеть не ждёт.
    refreshExternal().catch(() => {});
  });

  fastify.addHook('onClose', async () => {
    unsubscribe?.();

    if (externalTimer) {
      clearInterval(externalTimer);
    }
    if (sampleTimer) {
      clearInterval(sampleTimer);
    }
  });

  fastify.get('/api/usage-forecast', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');

    return snapshot();
  });
}

export default fp(usageForecastModule, { name: 'module-usage-forecast' });
