// Внешний сигнал о сбросах Codex — codexreset.org. У сайта нет API: история
// подтверждённых сбросов и оценка «шанс сброса за 24/48 часов» вшиты в HTML главной
// как сериализованное состояние загрузчика. Отсюда берутся ровно два факта — когда
// был последний подтверждённый сброс и какова их оценка, — и ничего не исполняется:
// чужой скрипт разбирается регулярными выражениями, а не запускается.
//
// Файл — точка отсечения: без него раздел продолжает жить своими данными, а во
// всплывашке просто нет строки про внешний сигнал.
import type { ExternalReset, ExternalResetSignal } from '../../../../shared/usageForecastContracts.ts';

export const CODEX_RESET_PROVIDER_ID = 'codex';
export const CODEX_RESET_SOURCE = 'codexreset.org';
export const CODEX_RESET_HOMEPAGE = 'https://codexreset.org/';

// Раз в час: сайт сам обновляется не чаще, а страница весит около мегабайта.
export const CODEX_RESET_TTL_MS = 60 * 60_000;
// Сеть до сайта рвётся сериями: одна попытка с таймаутом, повтор — на следующем тике.
export const CODEX_RESET_TIMEOUT_MS = 30_000;
// Сигнал старше суток показывается с оговоркой: за сутки сброс мог случиться и пройти.
export const CODEX_RESET_STALE_MS = 24 * 60 * 60_000;

// Типы записей истории, которые сайт считает состоявшимся сбросом.
const RESET_KINDS = new Set(['forced-reset', 'compensation']);
// Ссылка на первоисточник допускается только на площадки, где пишут сами OpenAI.
const SOURCE_HOSTS = new Set(['x.com', 'twitter.com', 'openai.com', 'status.openai.com']);
const MAX_TEXT = 160;

export interface CodexResetParsed {
  lastReset: ExternalReset | null;
  chance24h: number | null;
  chance48h: number | null;
}

// Строковое поле сериализованного объекта: `key:"…"` с экранированными кавычками.
function fieldOf(item: string, key: string): string {
  const match = item.match(new RegExp(`(?:^\\{|,)${key}:"((?:[^"\\\\]|\\\\.)*)"`));

  const raw = match?.[1];

  if (raw === undefined) {
    return '';
  }

  try {
    return String(JSON.parse(`"${raw}"`));
  } catch {
    return raw;
  }
}

// Текст с сайта — недоверенный: режем длину и управляющие символы, остальное экранирует шаблон.
function plainText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function sourceUrlOf(value: string): string | null {
  try {
    const url = new URL(value);

    return url.protocol === 'https:' && SOURCE_HOSTS.has(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

function chanceOf(segment: string, key: string): number | null {
  const match = segment.match(new RegExp(`[,{]${key}:(\\d+(?:\\.\\d+)?)`));
  const value = match ? Number(match[1]) : Number.NaN;

  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/**
 * Разбор HTML главной. Записи истории — плоские объекты вида
 * `{id:"reset:…",dateTime:"…",title:"…",type:"forced-reset",scope:"…",sourceLabel:"…",sourceUrl:"…"}`;
 * последняя по времени и есть «последний сброс». Оценка лежит в объекте `forecast`
 * полями `score24h`/`score48h`. Всё, что не сошлось с ожидаемой формой, даёт null —
 * так сломанная вёрстка сайта выглядит как «нет сигнала», а не как ложная дата.
 */
export function parseCodexResetPage(html: string, { now }: { now: number }): CodexResetParsed {
  let lastReset: ExternalReset | null = null;
  let lastAt = 0;

  for (const item of html.match(/\{id:"reset:[^"]*"[^{}]*\}/g) || []) {
    if (!RESET_KINDS.has(fieldOf(item, 'type'))) {
      continue;
    }

    const at = Date.parse(fieldOf(item, 'dateTime'));

    if (!Number.isFinite(at) || at > now + 24 * 60 * 60_000 || at <= lastAt) {
      continue;
    }

    lastAt = at;
    lastReset = {
      at: new Date(at).toISOString(),
      title: plainText(fieldOf(item, 'title')) || 'Сброс квоты Codex',
      scope: plainText(fieldOf(item, 'scope')),
      sourceLabel: plainText(fieldOf(item, 'sourceLabel')),
      sourceUrl: sourceUrlOf(fieldOf(item, 'sourceUrl')),
    };
  }

  const forecastAt = html.indexOf(',forecast:');
  const segment = forecastAt >= 0 ? html.slice(forecastAt, forecastAt + 4_000) : '';

  return {
    lastReset,
    chance24h: chanceOf(segment, 'score24h'),
    chance48h: chanceOf(segment, 'score48h'),
  };
}

export interface CodexResetSourceOptions {
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  timeoutMs?: number;
  homepage?: string;
}

/**
 * Читатель с памятью: удачный ответ живёт TTL, неудача возвращает прошлый удачный
 * с пометкой `stale` и текстом ошибки. Пустой ответ вместо вчерашнего показывать
 * незачем — вопрос «когда был последний сброс» вчерашние данные закрывают.
 */
export function createCodexResetSource(options: CodexResetSourceOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlMs = options.ttlMs ?? CODEX_RESET_TTL_MS;
  const timeoutMs = options.timeoutMs ?? CODEX_RESET_TIMEOUT_MS;
  const homepage = options.homepage ?? CODEX_RESET_HOMEPAGE;

  let lastGood: { at: number; parsed: CodexResetParsed } | null = null;
  let lastError: string | null = null;
  let lastTriedAt = 0;
  let inflight: Promise<void> | null = null;

  function signalAt(now: number): ExternalResetSignal {
    const age = lastGood ? now - lastGood.at : Number.POSITIVE_INFINITY;

    return {
      providerId: CODEX_RESET_PROVIDER_ID,
      source: CODEX_RESET_SOURCE,
      homepage,
      fetchedAt: lastGood ? new Date(lastGood.at).toISOString() : null,
      stale: !lastGood || age > CODEX_RESET_STALE_MS,
      error: lastError,
      lastReset: lastGood?.parsed.lastReset ?? null,
      chance24h: lastGood?.parsed.chance24h ?? null,
      chance48h: lastGood?.parsed.chance48h ?? null,
    };
  }

  async function fetchOnce(now: number): Promise<void> {
    lastTriedAt = now;

    try {
      const response = await fetchImpl(homepage, {
        headers: { 'user-agent': 'Cockpit usage forecast (+local)', accept: 'text/html' },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const parsed = parseCodexResetPage(await response.text(), { now });

      if (!parsed.lastReset && parsed.chance24h === null) {
        throw new Error('страница без истории сбросов — вёрстка сайта изменилась');
      }

      lastGood = { at: now, parsed };
      lastError = null;
    } catch (error) {
      lastError = (error as Error)?.message || 'не удалось получить';
    }
  }

  return {
    /** Сигнал на момент `now`; при протухшем кэше — сначала попытка обновить. */
    async read(now = Date.now()): Promise<ExternalResetSignal> {
      const fresh = lastGood && now - lastGood.at < ttlMs;
      // После неудачи повтор не раньше, чем через десятую долю TTL: серия обрывов
      // сети не должна превращаться в серию мегабайтных загрузок.
      const cooling = !fresh && lastError && now - lastTriedAt < ttlMs / 10;

      if (!fresh && !cooling) {
        inflight ||= fetchOnce(now).finally(() => {
          inflight = null;
        });
        await inflight;
      }

      return signalAt(now);
    },

    /** Текущее состояние без похода в сеть — для ответа на запрос окна. */
    peek(now = Date.now()): ExternalResetSignal {
      return signalAt(now);
    },
  };
}

export type CodexResetSource = ReturnType<typeof createCodexResetSource>;
