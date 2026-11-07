// Последовательное сопоставление измеренных границ речи с каноническим текстом.
//
// Поставщик речи отвечает только за шкалу WAV и услышанный текст. Индексы в
// `narration` вычисляются здесь: так метки Edge, SpeechKit и общего Whisper идут
// одним путём, а «ё/е» и пунктуация не меняют текст, который произносит голос.
// Неверные или неоднозначные слова никогда не распределяются по длительности
// дорожки. В таком случае остаётся измеренная фраза либо честный approximate.

import type {
  SafeSpeechPause,
  SpeechFixtureTiming,
  SpeechPhraseTiming,
  SpeechSpanTiming,
} from '../render/syncPlan.ts';

export interface TimedSpeechText {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SpeechTimingInput {
  words?: readonly TimedSpeechText[] | null;
  segments?: readonly TimedSpeechText[] | null;
}

export interface SpeechAlignment {
  canonicalText: string;
  durationMs: number;
  quality: 'word-exact' | 'phrase' | 'approximate';
  spans: SpeechSpanTiming[];
  phrases: SpeechPhraseTiming[];
  safePauses: SafeSpeechPause[];
  reason: string;
}

interface TextToken {
  text: string;
  normalized: string;
  from: number;
  to: number;
}

interface TimedToken {
  normalized: string;
  startMs: number;
  endMs: number;
}

interface TextRange {
  from: number;
  to: number;
}

const END_TOLERANCE_MS = 1;
const WORD = /[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu;
const PHRASE_END = /[.!?\n]+/gu;
// Знаки, на которых синтез делает паузу внутри фразы. Дефис между словами сюда не
// входит: «десктоп-версия» читается слитно, и тишины между половинами нет.
const CLAUSE_PAUSE = /[,;:—–]/u;
// Порог измеренной тишины между словами, чтобы считать её паузой синтеза, а не
// шагом границ слов: Edge и локальные голоса на запятой держат 140–350 мс.
const MIN_CLAUSE_PAUSE_MS = 100;

function normalizeToken(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
}

function textTokens(value: string): TextToken[] {
  const result: TextToken[] = [];

  for (const match of value.matchAll(WORD)) {
    const text = match[0];
    const from = match.index;

    result.push({
      text,
      normalized: normalizeToken(text),
      from,
      to: from + text.length,
    });
  }

  return result;
}

/**
 * Проверяет шкалу до сопоставления. Небольшой хвост ffprobe округляется только
 * на конце; порядок не сортируется и пересекающиеся слова не исправляются.
 */
export function normalizeMeasuredSpeechSpans(
  value: readonly TimedSpeechText[] | null | undefined,
  durationMs: number,
): TimedSpeechText[] | null {
  if (!Array.isArray(value) || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }

  const result: TimedSpeechText[] = [];
  let previousEndMs = 0;

  for (const source of value) {
    if (
      source === null
      || typeof source !== 'object'
      || typeof source.text !== 'string'
      || source.text.trim().length === 0
      || typeof source.startMs !== 'number'
      || !Number.isFinite(source.startMs)
      || typeof source.endMs !== 'number'
      || !Number.isFinite(source.endMs)
      || source.startMs < 0
      || source.startMs < previousEndMs
      || source.endMs <= source.startMs
      || source.endMs > durationMs + END_TOLERANCE_MS
    ) {
      return null;
    }

    const endMs = Math.min(source.endMs, durationMs);

    if (endMs <= source.startMs) {
      return null;
    }

    result.push({ text: source.text, startMs: source.startMs, endMs });
    previousEndMs = endMs;
  }

  return result;
}

function timedWordTokens(spans: readonly TimedSpeechText[]): TimedToken[] | null {
  const result: TimedToken[] = [];

  for (const span of spans) {
    const tokens = textTokens(span.text);

    // Одно измерение, содержащее несколько лексем, не даёт их внутренних границ.
    const [token] = tokens;

    if (tokens.length !== 1 || !token) {
      return null;
    }

    result.push({
      normalized: token.normalized,
      startMs: span.startMs,
      endMs: span.endMs,
    });
  }

  return result;
}

function canonicalPhraseRanges(text: string, tokens: readonly TextToken[]): TextRange[] {
  if (tokens.length === 0) {
    return [];
  }

  const ranges: TextRange[] = [];
  let tokenFrom = 0;

  for (const boundary of text.matchAll(PHRASE_END)) {
    const edge = boundary.index + boundary[0].length;
    let tokenTo = tokenFrom;

    while ((tokens.at(tokenTo)?.to ?? Number.POSITIVE_INFINITY) <= edge) {
      tokenTo += 1;
    }

    if (tokenTo > tokenFrom) {
      const first = tokens.at(tokenFrom);
      const last = tokens.at(tokenTo - 1);

      if (first && last) {
        ranges.push({ from: first.from, to: last.to });
      }
      tokenFrom = tokenTo;
    }
  }

  if (tokenFrom < tokens.length) {
    const first = tokens.at(tokenFrom);

    if (first) {
      ranges.push({ from: first.from, to: tokens.at(-1)?.to ?? text.length });
    }
  }

  return ranges;
}

function phrasesFromWords(
  text: string,
  tokens: readonly TextToken[],
  spans: readonly SpeechSpanTiming[],
): SpeechPhraseTiming[] {
  return canonicalPhraseRanges(text, tokens).flatMap((range, index) => {
    const own = spans.filter((span) => range.from <= span.from && span.to <= range.to);

    if (own.length === 0) {
      return [];
    }

    const first = own.at(0);
    const last = own.at(-1);

    if (!first || !last) {
      return [];
    }

    return [{
      id: `phrase-${index + 1}`,
      from: range.from,
      to: range.to,
      startMs: first.startMs,
      endMs: last.endMs,
    }];
  });
}

function pausesOf(phrases: readonly SpeechPhraseTiming[]): SafeSpeechPause[] {
  const result: SafeSpeechPause[] = [];

  for (let index = 1; index < phrases.length; index += 1) {
    const previous = phrases[index - 1];
    const next = phrases[index];

    if (!previous || !next) {
      continue;
    }

    if (previous.endMs >= next.startMs) {
      continue;
    }

    result.push({
      id: `pause-${index}`,
      textAt: previous.to,
      atMs: (previous.endMs + next.startMs) / 2,
      quietFromMs: previous.endMs,
      quietToMs: next.startMs,
    });
  }

  return result;
}

/**
 * Паузы внутри фразы: синтез сам остановился на запятой, двоеточии или тире, и это
 * видно по измеренной тишине между соседними словами. Только сентенциальных пауз
 * планировщику не хватало — модель пишет реплику одним предложением, безопасных
 * пауз выходило ноль, и позднее действие нельзя было совместить с речью иначе как
 * остановкой на человеке. Тишина вставляется в середину измеренной паузы, слово
 * не режется.
 */
function clausePausesOf(text: string, spans: readonly SpeechSpanTiming[]): SafeSpeechPause[] {
  const result: SafeSpeechPause[] = [];

  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1];
    const next = spans[index];

    if (!previous || !next) {
      continue;
    }

    if (
      next.startMs - previous.endMs < MIN_CLAUSE_PAUSE_MS
      || !CLAUSE_PAUSE.test(text.slice(previous.to, next.from))
    ) {
      continue;
    }

    result.push({
      id: `clause-${index}`,
      textAt: previous.to,
      atMs: (previous.endMs + next.startMs) / 2,
      quietFromMs: previous.endMs,
      quietToMs: next.startMs,
    });
  }

  return result;
}

/** Паузы фраз и паузы внутри фраз в порядке звучания; общих точек у них нет. */
function mergePauses(
  ...groups: readonly (readonly SafeSpeechPause[])[]
): SafeSpeechPause[] {
  return groups.flat().sort((left, right) => left.atMs - right.atMs || left.textAt - right.textAt);
}

function exactWordAlignment(
  canonical: readonly TextToken[],
  measured: readonly TimedToken[],
): SpeechSpanTiming[] | null {
  // Полное попарное совпадение намеренно строже fuzzy/LCS. Оно однозначно и при
  // повторах («нет, нет»), а пропущенное слово, число словами или расшифрованная
  // аббревиатура не получают выдуманную словесную границу.
  if (
    canonical.length === 0
    || measured.length !== canonical.length
    || canonical.some((token, index) => token.normalized !== measured[index]?.normalized)
  ) {
    return null;
  }

  const result: SpeechSpanTiming[] = [];

  for (const [index, token] of canonical.entries()) {
    const measuredToken = measured.at(index);

    if (!measuredToken) {
      return null;
    }

    result.push({
      from: token.from,
      to: token.to,
      startMs: measuredToken.startMs,
      endMs: measuredToken.endMs,
      precision: 'word',
    });
  }

  return result;
}

function normalizedWords(value: string): string[] {
  return textTokens(value).map((token) => token.normalized);
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

function exactSegmentRanges(
  canonical: readonly TextToken[],
  segments: readonly TimedSpeechText[],
): TextRange[] | null {
  const ranges: TextRange[] = [];
  let cursor = 0;

  for (const segment of segments) {
    const wanted = normalizedWords(segment.text);

    if (wanted.length === 0) {
      return null;
    }

    const candidates: { fromToken: number; toToken: number }[] = [];

    for (let fromToken = cursor; fromToken + wanted.length <= canonical.length; fromToken += 1) {
      const slice = canonical
        .slice(fromToken, fromToken + wanted.length)
        .map((token) => token.normalized);

      if (sameWords(slice, wanted)) {
        candidates.push({ fromToken, toToken: fromToken + wanted.length });
      }
    }

    // Повтор фразы без достаточного следующего контекста неоднозначен. По номеру
    // вхождения здесь угадывать нельзя — его должен дать сценарий/ручная привязка.
    if (candidates.length !== 1) {
      return null;
    }

    const selected = candidates.at(0);
    const first = selected ? canonical.at(selected.fromToken) : null;
    const last = selected ? canonical.at(selected.toToken - 1) : null;

    if (!selected || !first || !last) {
      return null;
    }

    ranges.push({ from: first.from, to: last.to });
    cursor = selected.toToken;
  }

  return ranges;
}

function tokenOverlap(left: readonly string[], right: readonly string[]): number {
  const available = new Map<string, number>();

  for (const word of right) {
    available.set(word, (available.get(word) ?? 0) + 1);
  }

  let overlap = 0;

  for (const word of left) {
    const count = available.get(word) ?? 0;

    if (count > 0) {
      overlap += 1;
      available.set(word, count - 1);
    }
  }

  return overlap;
}

function phraseRanges(
  text: string,
  canonical: readonly TextToken[],
  segments: readonly TimedSpeechText[],
): TextRange[] | null {
  const exact = exactSegmentRanges(canonical, segments);

  if (exact) {
    return exact;
  }

  const canonicalRanges = canonicalPhraseRanges(text, canonical);

  if (segments.length !== canonicalRanges.length || segments.length === 0) {
    return null;
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments.at(index);
    const range = canonicalRanges.at(index);

    if (!segment || !range) {
      return null;
    }

    const heard = normalizedWords(segment.text);
    const expected = canonical
      .filter((token) => range.from <= token.from && token.to <= range.to)
      .map((token) => token.normalized);
    const overlap = tokenOverlap(heard, expected);

    // Одна подтверждённая опора привязывает целую измеренную фразу. Внутри неё
    // ничего не объявляется словом: это и есть безопасное понижение для «2026» /
    // «две тысячи двадцать шестой» и сокращений.
    if (overlap === 0) {
      return null;
    }
  }

  return canonicalRanges;
}

function measuredPhrases(
  text: string,
  canonical: readonly TextToken[],
  segments: readonly TimedSpeechText[],
): SpeechPhraseTiming[] | null {
  const ranges = phraseRanges(text, canonical, segments);

  if (!ranges || ranges.length !== segments.length) {
    return null;
  }

  const result: SpeechPhraseTiming[] = [];

  for (const [index, range] of ranges.entries()) {
    const segment = segments.at(index);

    if (!segment) {
      return null;
    }

    result.push({
      id: `phrase-${index + 1}`,
      from: range.from,
      to: range.to,
      startMs: segment.startMs,
      endMs: segment.endMs,
    });
  }

  return result;
}

/**
 * Выбирает лучший доказанный режим: все слова → измеренные фразы → approximate.
 * Последний режим не содержит времён текста и потому не может случайно попасть в
 * точный planner; вызывающий сохраняет старый монтаж и показывает причину.
 */
export function alignSpeechTiming({
  canonicalText,
  durationMs,
  timing,
}: {
  canonicalText: string;
  durationMs: number;
  timing: SpeechTimingInput | null | undefined;
}): SpeechAlignment {
  const canonical = textTokens(canonicalText);
  const words = normalizeMeasuredSpeechSpans(timing?.words, durationMs);
  const segments = normalizeMeasuredSpeechSpans(timing?.segments, durationMs);
  const timedWords = words ? timedWordTokens(words) : null;
  const wordSpans = timedWords ? exactWordAlignment(canonical, timedWords) : null;

  if (wordSpans) {
    const phrases = phrasesFromWords(canonicalText, canonical, wordSpans);

    return {
      canonicalText,
      durationMs,
      quality: 'word-exact',
      spans: wordSpans,
      phrases,
      safePauses: mergePauses(pausesOf(phrases), clausePausesOf(canonicalText, wordSpans)),
      reason: 'Все слова однозначно сопоставлены с канонической репликой.',
    };
  }

  const phrases = segments ? measuredPhrases(canonicalText, canonical, segments) : null;

  if (phrases && phrases.length > 0) {
    return {
      canonicalText,
      durationMs,
      quality: 'phrase',
      spans: phrases.map((phrase) => ({
        from: phrase.from,
        to: phrase.to,
        startMs: phrase.startMs,
        endMs: phrase.endMs,
        precision: 'phrase',
      })),
      phrases,
      safePauses: pausesOf(phrases),
      reason: 'Слова неоднозначны; использованы только измеренные границы фраз.',
    };
  }

  return {
    canonicalText,
    durationMs,
    quality: 'approximate',
    spans: [],
    phrases: [],
    safePauses: [],
    reason: timing
      ? 'Распознанный текст нельзя однозначно связать с канонической репликой.'
      : 'Измеренные метки речи недоступны; нужен прежний приблизительный монтаж.',
  };
}

/** Добавляет к выравниванию измеренный PCM-профиль для чистого planner. */
export function speechFixtureOf(
  alignment: SpeechAlignment,
  { sampleRate, sampleCount }: { sampleRate: number; sampleCount: number },
): SpeechFixtureTiming {
  return {
    canonicalText: alignment.canonicalText,
    durationMs: alignment.durationMs,
    sampleRate,
    sampleCount,
    quality: alignment.quality,
    spans: alignment.spans,
    phrases: alignment.phrases,
    safePauses: alignment.safePauses,
  };
}
