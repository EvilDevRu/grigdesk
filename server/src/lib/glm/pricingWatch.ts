import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ensurePrivateDir } from '../deepseek/env.ts';
import {
  GLM_PEAK_WEEKDAYS,
  GLM_PEAK_WINDOW_UTC,
  GLM_PRICING_SOURCES,
  GLM_SOURCE_OFFSET_MINUTES,
  GLM_USAGE_RATES,
  GLM_WEEKENDS_OFF_PEAK,
} from './tariff.ts';

const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const RETRY_INTERVAL_MS = 60 * 60_000;
const SOURCES = ['overview', 'revision'] as const;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export type GlmPricingSource = typeof SOURCES[number];
type RateModel = keyof typeof GLM_USAGE_RATES;
type PricingKind = 'verified' | 'mismatch' | 'unparsed' | 'unreachable';

interface PeakSchedule {
  days: number[];
  start: number;
  end: number;
  offsetMinutes: number;
}

interface UsageRates {
  model: RateModel;
  offPeak: number;
  peak: number;
}

export interface GlmPricingPage {
  schedules: PeakSchedule[];
  rates: UsageRates[];
  weekendsOffPeak: boolean | null;
}

interface SourceSnapshot {
  checkedAt: number;
  fetchedAt: number | null;
  page: GlmPricingPage | null;
  failure: string | null;
}

export interface GlmPricingSnapshot {
  sources: Record<GlmPricingSource, SourceSnapshot>;
}

interface PricingObservation {
  kind: Exclude<PricingKind, 'unreachable'>;
  details: string[];
}

interface SourceStatus {
  kind: PricingKind;
  at: number | null;
  failure: string | null;
}

export interface GlmPricingStatus {
  kind: PricingKind;
  at: number | null;
  details: string[];
  sources: Record<GlmPricingSource, SourceStatus>;
}

/**
 * Снимает декоративную разметку, сохраняя числа, имена моделей и границы тарифных фраз.
 * Типографские дефисы и пробелы не должны превращать прежнее расписание в тревогу.
 */
function pricingText(markdown: string): string {
  return markdown
    .replace(/<[^>]+>/gu, ' ')
    .replace(/[*_`>]/gu, '')
    .replace(/[–—‑−]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Извлекает каждое повторение окна вместе с днями и исходным смещением UTC.
 * Числа на странице читаются независимо от ожидаемых констант, чтобы увидеть их изменение.
 */
function schedulesOf(text: string): PeakSchedule[] {
  const pattern = /Peak hours\s*:\s*([A-Za-z]+)\s+to\s+([A-Za-z]+),\s*/giu;
  const window = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*/u;
  const zone = /^Singapore Standard Time\s*\(UTC([+-])(\d{1,2})(?::(\d{2}))?\)/iu;
  const schedules: PeakSchedule[] = [];

  for (const match of text.matchAll(pattern)) {
    const times = text.slice(match.index + match[0].length).match(window);
    const firstDay = WEEKDAYS.findIndex((day) => day.toLowerCase() === match[1]!.toLowerCase());
    const lastDay = WEEKDAYS.findIndex((day) => day.toLowerCase() === match[2]!.toLowerCase());

    if (!times || firstDay < 0 || lastDay < 0) {
      continue;
    }

    const timezone = text.slice(match.index + match[0].length + times[0].length).match(zone);

    if (!timezone) {
      continue;
    }

    const dayCount = (lastDay - firstDay + 7) % 7 + 1;
    const days = Array.from({ length: dayCount }, (_, index) => (firstDay + index) % 7);
    const offset = Number(timezone[2]) * 60 + Number(timezone[3] ?? 0);

    schedules.push({
      days,
      start: Number(times[1]) * 60 + Number(times[2]),
      end: Number(times[3]) * 60 + Number(times[4]),
      offsetMinutes: timezone[1] === '-' ? -offset : offset,
    });
  }

  return schedules;
}

/**
 * Читает пары исходных расходов, а не только отношение пика к времени вне пика.
 * Каждая legacy-модель и каждый повтор пары остаются отдельным проверяемым фактом.
 */
function ratesOf(source: GlmPricingSource, text: string): UsageRates[] {
  if (source === 'overview') {
    const offPeak = /during off-peak hours and is charged at (\d+(?:\.\d+)?)\s*[×x]/iu;
    const peak = /during peak hours and is charged at (\d+(?:\.\d+)?)\s*[×x]/iu;
    const off = text.match(offPeak);
    const on = text.match(peak);

    return off && on ? [{
      model: 'credits',
      offPeak: Number(off[1]),
      peak: Number(on[1]),
    }] : [];
  }

  const pattern = /\b(GLM-5\.3(?:-Flash)?)\s*:[^:]*?consume quota at a rate of\s*"?/giu;
  const pair = /^(\d+(?:\.\d+)?)\s*[×x] during off-peak hours and\s*/iu;
  const peak = /^(\d+(?:\.\d+)?)\s*[×x] during peak hours/iu;
  const rates: UsageRates[] = [];

  for (const match of text.matchAll(pattern)) {
    const tail = text.slice(match.index + match[0].length);
    const off = tail.match(pair);
    const on = off ? tail.slice(off[0].length).match(peak) : null;

    if (off && on) {
      rates.push({
        model: match[1]!.toLowerCase().endsWith('-flash') ? 'GLM-5.3-Flash' : 'GLM-5.3',
        offPeak: Number(off[1]),
        peak: Number(on[1]),
      });
    }
  }

  return rates;
}

/**
 * Возвращает только наблюдённые факты двух публичных Markdown-источников Z.ai.
 * Полнота и соответствие тарифу оцениваются отдельно, в том числе после чтения снимка.
 */
export function parseGlmPricingPage(source: GlmPricingSource, markdown: string): GlmPricingPage {
  const text = pricingText(markdown);
  const weekend = text.match(/weekends will be deducted at (off-peak|peak) rates all day/iu);

  return {
    schedules: schedulesOf(text),
    rates: ratesOf(source, text),
    weekendsOffPeak: weekend ? weekend[1]!.toLowerCase() === 'off-peak' : null,
  };
}

/**
 * Сопоставляет все прочитанные значения с единственным владельцем тарифных констант.
 * Доказанное отличие важнее неполной страницы; неполнота сама по себе остаётся тихой.
 */
export function compareGlmPricingPage(
  source: GlmPricingSource,
  page: GlmPricingPage,
): PricingObservation {
  const details: string[] = [];
  const expectedStart = GLM_PEAK_WINDOW_UTC.start + GLM_SOURCE_OFFSET_MINUTES;
  const expectedEnd = GLM_PEAK_WINDOW_UTC.end + GLM_SOURCE_OFFSET_MINUTES;

  for (const schedule of page.schedules) {
    if (schedule.start !== expectedStart || schedule.end !== expectedEnd) {
      details.push(`${source}: часы пика на сайте ${schedule.start}–${schedule.end} минут`);
    }

    if (schedule.days.join(',') !== GLM_PEAK_WEEKDAYS.join(',')) {
      details.push(`${source}: дни пика на сайте ${schedule.days.join(', ')}`);
    }

    if (schedule.offsetMinutes !== GLM_SOURCE_OFFSET_MINUTES) {
      details.push(`${source}: зона пика на сайте ${schedule.offsetMinutes} минут от UTC`);
    }
  }

  for (const rates of page.rates) {
    const expected = GLM_USAGE_RATES[rates.model];

    if (rates.offPeak !== expected.offPeak || rates.peak !== expected.peak) {
      const label = rates.model === 'credits' ? 'кредиты' : rates.model;

      details.push(`${source}: ${label} на сайте ${rates.offPeak}× вне пика / ${rates.peak}× в пик`);
    }
  }

  if (page.weekendsOffPeak !== null && page.weekendsOffPeak !== GLM_WEEKENDS_OFF_PEAK) {
    details.push(`${source}: выходные на сайте целиком в пик (weekendsOffPeak=false)`);
  }

  if (details.length) {
    return { kind: 'mismatch', details };
  }

  const requiredModels: RateModel[] = source === 'overview' ? ['credits'] : ['GLM-5.3', 'GLM-5.3-Flash'];
  const repetitions = source === 'overview' ? 1 : 2;
  const complete = page.schedules.length >= repetitions
    && requiredModels.every((model) => (
      page.rates.filter((rate) => rate.model === model).length >= repetitions
    ))
    && (source !== 'revision' || page.weekendsOffPeak !== null);

  return { kind: complete ? 'verified' : 'unparsed', details: [] };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSchedule(value: unknown): value is PeakSchedule {
  const item = record(value);

  return !!item && Array.isArray(item.days)
    && item.days.every((day: unknown) => finite(day) && Number.isInteger(day) && day >= 0 && day <= 6)
    && finite(item.start) && finite(item.end) && finite(item.offsetMinutes);
}

function isRates(value: unknown): value is UsageRates {
  const item = record(value);

  return !!item && typeof item.model === 'string' && Object.hasOwn(GLM_USAGE_RATES, item.model)
    && finite(item.offPeak) && item.offPeak >= 0 && finite(item.peak) && item.peak >= 0;
}

function isPage(value: unknown): value is GlmPricingPage {
  const page = record(value);

  return !!page && Array.isArray(page.schedules) && page.schedules.every(isSchedule)
    && Array.isArray(page.rates) && page.rates.every(isRates)
    && (page.weekendsOffPeak === null || typeof page.weekendsOffPeak === 'boolean');
}

/**
 * Проверяет числа и структуру фактов снимка до передачи в сравнение и расчёт интервалов.
 * Посторонние поля, включая старые выводы сторожа, не переходят в новый снимок.
 */
function normalizeSource(value: unknown): SourceSnapshot | null {
  const source = record(value);

  if (!source || !finite(source.checkedAt) || source.checkedAt < 0) {
    return null;
  }

  if (source.failure !== null && typeof source.failure !== 'string') {
    return null;
  }

  const page = source.page === null ? null : (isPage(source.page) ? source.page : undefined);
  const fetchedAt = source.fetchedAt;

  if (page === undefined || (fetchedAt !== null && (!finite(fetchedAt) || fetchedAt < 0))) {
    return null;
  }

  if ((page === null) !== (fetchedAt === null) || (fetchedAt !== null && fetchedAt > source.checkedAt)) {
    return null;
  }

  return {
    checkedAt: source.checkedAt,
    fetchedAt,
    page,
    failure: source.failure,
  };
}

/**
 * Отделяет снимок публичных тарифов GLM от баланса и снимков других исполнителей.
 * Корень задаёт вызывающий адаптер, поэтому путь не зависит от рабочего каталога сервера.
 */
export function glmPricingSnapshotPath(runtimeHome: string): string {
  return path.join(runtimeHome, 'glm-pricing-check.json');
}

/**
 * Читает приватный снимок без требования, чтобы каталог уже существовал.
 * Битый файл не является фактом о тарифе и приводит к новой публичной сверке.
 */
export async function readGlmPricingSnapshot(runtimeHome: string): Promise<GlmPricingSnapshot | null> {
  try {
    const parsed = record(JSON.parse(await fs.readFile(glmPricingSnapshotPath(runtimeHome), 'utf8')));
    const sources = record(parsed?.sources);
    const overview = normalizeSource(sources?.overview);
    const revision = normalizeSource(sources?.revision);

    return overview && revision ? { sources: { overview, revision } } : null;
  } catch {
    return null;
  }
}

/**
 * Отправляет GET исключительно публичной документации без ключей и cookie кабинета.
 * Ошибки сети и чтения тела сохраняются только кодом, без потенциально приватного текста.
 */
async function fetchPage(
  source: GlmPricingSource,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ page: GlmPricingPage; failure: null } | { page: null; failure: string }> {
  try {
    const response = await fetchImpl(GLM_PRICING_SOURCES[source], {
      method: 'GET',
      headers: { Accept: 'text/markdown' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return { page: null, failure: `HTTP ${response.status}` };
    }

    return { page: parseGlmPricingPage(source, await response.text()), failure: null };
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
    const failure = String(cause || (error as Error)?.name || 'сеть');

    return { page: null, failure };
  }
}

/**
 * Обновляет каждый источник по собственным часам: сутки после ответа, час после отказа.
 * Неудачный запрос сохраняет прежние факты, а будущий снимок не задерживает новую попытку.
 */
async function updateSource(
  source: GlmPricingSource,
  previous: SourceSnapshot | undefined,
  now: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SourceSnapshot> {
  const valid = previous && previous.checkedAt <= now ? previous : undefined;
  const interval = valid?.failure ? RETRY_INTERVAL_MS : CHECK_INTERVAL_MS;

  if (valid && now - valid.checkedAt < interval) {
    return valid;
  }

  const fetched = await fetchPage(source, fetchImpl, timeoutMs);

  return {
    checkedAt: now,
    fetchedAt: fetched.page ? now : (valid?.fetchedAt ?? null),
    page: fetched.page ?? valid?.page ?? null,
    failure: fetched.failure,
  };
}

/**
 * Сверка вызывается опросом usage, без отдельных таймеров и демонов.
 * Отказ записи снимка не отменяет уже полученных фактов и подтверждённого расхождения.
 */
export async function watchGlmPricing({
  runtimeHome,
  fetchImpl = fetch,
  now = Date.now(),
  timeoutMs = 8_000,
}: {
  runtimeHome: string;
  fetchImpl?: typeof fetch;
  now?: number;
  timeoutMs?: number;
}): Promise<GlmPricingSnapshot> {
  const previous = await readGlmPricingSnapshot(runtimeHome);
  const [overview, revision] = await Promise.all(SOURCES.map((source) => (
    updateSource(source, previous?.sources[source], now, fetchImpl, timeoutMs)
  )));
  const snapshot: GlmPricingSnapshot = { sources: { overview: overview!, revision: revision! } };

  try {
    await ensurePrivateDir(runtimeHome);

    const file = glmPricingSnapshotPath(runtimeHome);

    await fs.writeFile(file, JSON.stringify(snapshot), { mode: 0o600 });
    await fs.chmod(file, 0o600);
  } catch {
    // Диск не должен превращать успешные квоты или доказанное изменение тарифа в отказ.
  }

  return snapshot;
}

/**
 * Вывод пересчитывается по фактам против текущих констант при каждом чтении.
 * Любое доказанное расхождение имеет приоритет над сетевым отказом другого источника.
 */
export function glmPricingStatus(snapshot: GlmPricingSnapshot | null): GlmPricingStatus {
  const details: string[] = [];
  const statuses = SOURCES.map((source): SourceStatus => {
    const saved = snapshot?.sources[source];
    const observation = saved?.page ? compareGlmPricingPage(source, saved.page) : null;

    details.push(...(observation?.details ?? []));

    const kind = observation?.kind === 'mismatch'
      ? 'mismatch'
      : (saved?.failure || !observation ? 'unreachable' : observation.kind);

    return {
      kind,
      at: saved?.fetchedAt ?? null,
      failure: saved?.failure ?? null,
    };
  });
  const kinds = statuses.map((status) => status.kind);
  const priority: PricingKind[] = ['mismatch', 'unreachable', 'unparsed', 'verified'];
  const kind = priority.find((candidate) => kinds.includes(candidate))!;
  const dates = statuses.flatMap((status) => status.at === null ? [] : [status.at]);

  return {
    kind,
    at: dates.length ? Math.min(...dates) : null,
    details,
    sources: { overview: statuses[0]!, revision: statuses[1]! },
  };
}
