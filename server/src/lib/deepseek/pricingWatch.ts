import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ensurePrivateDir } from './env.ts';
import {
  DEEPSEEK_PEAK_MULTIPLIER,
  DEEPSEEK_PEAK_WINDOWS_UTC,
  DEEPSEEK_PRICING_URL,
} from './tariff.ts';

// Расписание пика и скидка зашиты константами: API тарифов у DeepSeek нет, страница цен —
// обычный HTML, а об изменениях вендор пишет постом. Сторож раз в сутки перечитывает
// страницу и сверяет её с константами, чтобы смена часов стала видимой бедой ресурса
// «Тариф», а не молча удвоенным счётом.
export const PRICING_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
// Недоступный сайт — не повод ждать сутки: следующая попытка через час.
export const PRICING_RETRY_MS = 60 * 60_000;
// Пары цен таблицы сверяются с множителем с допуском на округление вендора.
const PAIR_TOLERANCE = 0.02;

export interface PeakWindow {
  start: number;
  end: number;
}

export interface PricePair {
  offPeak: number;
  peak: number;
}

// Разбор страницы: только факты, без вывода — сверка с константами делается при чтении,
// чтобы после правки констант старый снимок не держал ложную тревогу до следующей сверки.
export interface DeepSeekPricingPage {
  peakSentence: string | null;
  peakWindows: PeakWindow[];
  peakQualifier: string;
  offPeakSentence: string | null;
  offPeakRatio: number | null;
  pricePairs: PricePair[];
}

export interface DeepSeekPricingSnapshot {
  checkedAt: number;
  fetchedAt: number | null;
  page: DeepSeekPricingPage | null;
  failure: string | null;
}

export type DeepSeekPricingObservation =
  | { kind: 'verified' }
  | { kind: 'mismatch'; details: string[] }
  | { kind: 'unparsed' };

export type DeepSeekPricingStatus =
  | { kind: 'verified'; at: number }
  | { kind: 'mismatch'; at: number; details: string[] }
  | { kind: 'unparsed'; at: number }
  | { kind: 'unreachable'; reason: string };

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};
const PEAK_SENTENCE = /Peak hours are\s+(.+?)\s*UTC\b[\s,]*([^.]*)\./iu;
const OFF_PEAK_SENTENCE = /Off-peak rates are\s+([^.]*)\./iu;
const WINDOW = /(\d{1,2}):(\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}):(\d{2})/gu;
const CELL = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu;
const PRICE = /^\$\s*(\d+(?:\.\d+)?)$/u;

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/gu, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/gu, ' ')
    .trim();
}

function windowsOf(text: string): PeakWindow[] {
  return [...text.matchAll(WINDOW)].map((match) => ({
    start: Number(match[1]) * 60 + Number(match[2]),
    end: Number(match[3]) * 60 + Number(match[4]),
  }));
}

/**
 * Доля пиковой цены из фразы о скидке: «half» и проценты «of/off» читаются, остальное —
 * неизвестная формулировка, которую покажут человеку целиком.
 */
function ratioOf(sentence: string): number | null {
  if (/\bhalf\b/iu.test(sentence)) return 1 / 2;

  const percent = sentence.match(/(\d+(?:\.\d+)?)\s*%\s*(of|off)\b/iu);
  if (!percent) return null;

  const share = Number(percent[1]) / 100;
  return percent[2]!.toLowerCase() === 'off' ? 1 - share : share;
}

function pricesAfter(cells: string[], from: number): number[] {
  const prices: number[] = [];

  for (let index = from; index < cells.length; index += 1) {
    const match = cells[index]!.match(PRICE);
    if (!match) break;
    prices.push(Number(match[1]));
  }

  return prices;
}

/**
 * Пары «OFF-PEAK … / PEAK …» из таблицы цен: строка скидки и следующая за ней строка пика
 * несут по цене на модель. Так ловится и скидка, изменённая для одной модели, о которой
 * общая фраза может промолчать.
 */
function pricePairsOf(html: string): PricePair[] {
  const cells = [...html.matchAll(CELL)].map((match) => textOf(match[1]!));
  const pairs: PricePair[] = [];

  for (let index = 0; index < cells.length; index += 1) {
    if (!/^off-?peak$/iu.test(cells[index]!)) continue;

    const offPeak = pricesAfter(cells, index + 1);
    const peakAt = index + 1 + offPeak.length;
    if (!offPeak.length || !/^peak$/iu.test(cells[peakAt] ?? '')) continue;

    const peak = pricesAfter(cells, peakAt + 1);
    for (let column = 0; column < Math.min(offPeak.length, peak.length); column += 1) {
      pairs.push({ offPeak: offPeak[column]!, peak: peak[column]! });
    }
  }

  return pairs;
}

/**
 * Вытаскивает из HTML страницы цен фразу о пиковых часах, фразу о размере скидки и пары
 * цен таблицы. Регулярки нарочно узкие: неузнанная страница даёт «не разобрано», а не
 * уверенно неверные часы.
 */
export function parseDeepSeekPricingPage(html: string): DeepSeekPricingPage {
  const text = textOf(html);
  const peak = text.match(PEAK_SENTENCE);
  const offPeak = text.match(OFF_PEAK_SENTENCE);

  return {
    peakSentence: peak ? peak[0] : null,
    peakWindows: peak ? windowsOf(peak[1]!) : [],
    peakQualifier: peak ? peak[2]!.trim() : '',
    offPeakSentence: offPeak ? offPeak[1]!.trim() : null,
    offPeakRatio: offPeak ? ratioOf(offPeak[1]!) : null,
    pricePairs: pricePairsOf(html),
  };
}

function clockOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function windowsKey(windows: readonly PeakWindow[]): string {
  return windows.map((window) => `${window.start}-${window.end}`).sort().join(',');
}

function offBy(observed: number, expected: number): boolean {
  return !(expected > 0) || Math.abs(observed / expected - 1) > PAIR_TOLERANCE;
}

/**
 * Сверяет разбор страницы с константами тарифа. Каждое расхождение — отдельная строка
 * для человека: он должен увидеть, что именно изменилось у вендора, а не только факт.
 */
export function compareDeepSeekPricing(page: DeepSeekPricingPage): DeepSeekPricingObservation {
  if (page.peakSentence === null) return { kind: 'unparsed' };

  const details: string[] = [];

  if (!page.peakWindows.length) {
    details.push(`пик на сайте описан иначе: «${page.peakSentence}»`);
  } else if (windowsKey(page.peakWindows) !== windowsKey(DEEPSEEK_PEAK_WINDOWS_UTC)) {
    const windows = page.peakWindows.map((window) => `${clockOf(window.start)}–${clockOf(window.end)}`);
    details.push(`пик на сайте ${windows.join(' и ')} UTC`);
  }

  if (!/monday/iu.test(page.peakQualifier) || !/holiday/iu.test(page.peakQualifier)) {
    details.push(page.peakQualifier
      ? `условие пика на сайте: «${page.peakQualifier}»`
      : 'на сайте пик без оговорки о буднях и праздниках');
  }

  if (page.offPeakSentence === null) {
    details.push('фраза о размере скидки на сайте не найдена');
  } else if (page.offPeakRatio === null || offBy(page.offPeakRatio * DEEPSEEK_PEAK_MULTIPLIER, 1)) {
    details.push(`скидка на сайте: «Off-peak rates are ${page.offPeakSentence}»`);
  }

  const odd = page.pricePairs.filter((pair) => offBy(pair.peak, pair.offPeak * DEEPSEEK_PEAK_MULTIPLIER));
  if (odd.length) {
    const pairs = odd.map((pair) => `$${pair.offPeak}/$${pair.peak}`);
    details.push(`в таблице цен пары не ×${DEEPSEEK_PEAK_MULTIPLIER}: ${pairs.join(', ')}`);
  }

  return details.length ? { kind: 'mismatch', details } : { kind: 'verified' };
}

export type DeepSeekPricingFetch =
  | { ok: true; page: DeepSeekPricingPage }
  | { ok: false; failure: string };

/**
 * Один GET публичной страницы цен. Ключ службы сюда не идёт: страница открытая, а
 * заголовок с ключом на чужой хост — утечка. Отказ описывается кодом причины без URL.
 */
export async function fetchDeepSeekPricingPage({
  fetchImpl = fetch,
  timeoutMs = 8_000,
}: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<DeepSeekPricingFetch> {
  let response: Response;
  try {
    response = await fetchImpl(DEEPSEEK_PRICING_URL, {
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
    return { ok: false, failure: String(cause || (error as Error)?.name || 'сеть') };
  }

  if (!response.ok) return { ok: false, failure: `HTTP ${response.status}` };

  try {
    return { ok: true, page: parseDeepSeekPricingPage(await response.text()) };
  } catch {
    return { ok: false, failure: 'обрыв ответа' };
  }
}

export function pricingSnapshotPath(runtimeHome: string): string {
  return path.join(runtimeHome, 'pricing-check.json');
}

function isWindowList(value: unknown): value is PeakWindow[] {
  return Array.isArray(value) && value.every((window) => (
    window && Number.isFinite(window.start) && Number.isFinite(window.end)
  ));
}

function isPairList(value: unknown): value is PricePair[] {
  return Array.isArray(value) && value.every((pair) => (
    pair && Number.isFinite(pair.offPeak) && Number.isFinite(pair.peak)
  ));
}

function normalizePage(raw: unknown): DeepSeekPricingPage | null {
  const value = raw as Partial<DeepSeekPricingPage> | null;
  if (!value || typeof value !== 'object') return null;
  if (!isWindowList(value.peakWindows) || !isPairList(value.pricePairs)) return null;

  return {
    peakSentence: typeof value.peakSentence === 'string' ? value.peakSentence : null,
    peakWindows: value.peakWindows,
    peakQualifier: typeof value.peakQualifier === 'string' ? value.peakQualifier : '',
    offPeakSentence: typeof value.offPeakSentence === 'string' ? value.offPeakSentence : null,
    offPeakRatio: Number.isFinite(value.offPeakRatio) ? Number(value.offPeakRatio) : null,
    pricePairs: value.pricePairs,
  };
}

export async function readPricingSnapshot(runtimeHome: string): Promise<DeepSeekPricingSnapshot | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(pricingSnapshotPath(runtimeHome), 'utf8'),
    ) as Partial<DeepSeekPricingSnapshot> | null;
    if (!parsed || !Number.isFinite(parsed.checkedAt)) return null;

    const page = normalizePage(parsed.page);
    return {
      checkedAt: Number(parsed.checkedAt),
      fetchedAt: page && Number.isFinite(parsed.fetchedAt) ? Number(parsed.fetchedAt) : null,
      page,
      failure: typeof parsed.failure === 'string' ? parsed.failure : null,
    };
  } catch {
    return null;
  }
}

/**
 * Сверка не чаще раза в сутки, после отказа сети — через час. Снимок лежит в приватном
 * файле runtime home, чтобы ни рестарт сервера, ни пятиминутный тик баланса не ходили на
 * сайт заново. Неудачная попытка не стирает прошлую удачно загруженную страницу: по ней
 * ресурс продолжает судить о тарифе и честно называет её возраст.
 */
export async function watchDeepSeekPricing({
  runtimeHome,
  fetchImpl = fetch,
  now = Date.now(),
  timeoutMs,
}: {
  runtimeHome: string;
  fetchImpl?: typeof fetch;
  now?: number;
  timeoutMs?: number;
}): Promise<DeepSeekPricingSnapshot> {
  const previous = await readPricingSnapshot(runtimeHome);
  const age = previous ? now - previous.checkedAt : Number.POSITIVE_INFINITY;
  const delay = previous?.failure ? PRICING_RETRY_MS : PRICING_CHECK_INTERVAL_MS;
  if (previous && age >= 0 && age < delay) return previous;

  const fetched = await fetchDeepSeekPricingPage({ fetchImpl, timeoutMs });
  const snapshot: DeepSeekPricingSnapshot = fetched.ok
    ? { checkedAt: now, fetchedAt: now, page: fetched.page, failure: null }
    : {
      checkedAt: now,
      fetchedAt: previous?.fetchedAt ?? null,
      page: previous?.page ?? null,
      failure: fetched.failure,
    };

  await ensurePrivateDir(runtimeHome);
  const file = pricingSnapshotPath(runtimeHome);
  await fs.writeFile(file, JSON.stringify(snapshot), { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return snapshot;
}

/**
 * Состояние сверки для ресурса «Тариф»: вывод считается по сохранённой странице против
 * текущих констант, поэтому исправленная константа снимает тревогу сразу после рестарта.
 */
export function deepSeekPricingStatus(
  snapshot: DeepSeekPricingSnapshot | null,
): DeepSeekPricingStatus | null {
  if (!snapshot) return null;
  if (!snapshot.page || snapshot.fetchedAt === null) {
    return { kind: 'unreachable', reason: snapshot.failure ?? 'сеть' };
  }

  return { ...compareDeepSeekPricing(snapshot.page), at: snapshot.fetchedAt };
}
