// Нотация ударения в тексте сцены и её разбор.
//
// Знак `+` перед ударной гласной — единственная разметка, которую человек и модель
// ставят прямо в тексте озвучки: она общая для всех движков, а в свою разметку её
// переводит каждый адаптер сам. Текст сцены хранится КАК НАБРАН, со знаками: человек
// видит, где поставил ударение. В субтитр, подпись и проверку речи знаки не попадают.
//
// Разбор живёт в общем слое: сервер строит по нему канонический текст для синтеза,
// браузер — субтитр по умолчанию, и две копии правила разошлись бы на первом же
// спорном случае вроде «2+2».

export interface NarrationStress {
  // Начало слова в каноническом тексте и сдвиг ударной гласной от него — ровно та
  // форма, которую ждёт разметка поставщика: `+` вставляется в позицию `at + vowel`.
  at: number;
  vowel: number;
}

export interface ParsedNarration {
  text: string;
  stresses: NarrationStress[];
}

export interface NarrationWord {
  at: number;
  word: string;
}

export interface PronunciationTextReplacement {
  from: number;
  to: number;
  pronunciation: string;
}

export interface PronunciationTextSegment {
  sourceFrom: number;
  sourceTo: number;
  outputFrom: number;
  outputTo: number;
  replaced: boolean;
}

export interface AppliedPronunciationText {
  sourceText: string;
  text: string;
  // Знаки `+` внутри произносимой строки проходят тот же разбор, что и текст
  // сцены, и становятся обычными структурированными ударениями.
  stresses: NarrationStress[];
  segments: PronunciationTextSegment[];
}

// Одна реплика остаётся короткой сценой, а не отдельной статьёй. Этим же пределом
// пользуются parser модельного сценария и preview, чтобы предпрослушивание не
// принимало текст, который затем нельзя сохранить как обычную сцену.
export const SHOWCASE_NARRATION_MAX_CHARS = 400;

const VOWELS = new Set('аеёиоуыэюяАЕЁИОУЫЭЮЯ');
const CYRILLIC_LETTER = /[а-яё]/i;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * `+` считается знаком ударения, если стоит в начале слова или после кириллической
 * буквы и сразу перед кириллической гласной: `з+амок`, `Арс+енал`, `+Арсенал`.
 * Любой другой `+` — обычный текст: «2+2» и «C++» остаются как есть.
 */
function isStressMark(text: string, index: number): boolean {
  if (text[index] !== '+') {
    return false;
  }

  const next = text[index + 1];

  if (next === undefined || !VOWELS.has(next)) {
    return false;
  }

  const previous = index > 0 ? text[index - 1] : undefined;

  return previous === undefined || CYRILLIC_LETTER.test(previous) || !WORD_CHAR.test(previous);
}

/**
 * Канонический текст и ударения. Знаки убираются, пробелы схлопываются, а позиция
 * каждой ударной гласной пересчитывается в координаты уже готового текста: смещения
 * должны указывать в ту строку, которую получит движок, а не в набранную.
 */
export function parseNarration(narration: string): ParsedNarration {
  let text = '';

  const vowelAt: number[] = [];

  for (let index = 0; index < narration.length; index += 1) {
    const char = narration[index] as string;

    if (isStressMark(narration, index)) {
      // Гласная идёт следующим символом и встанет ровно в конец накопленного текста.
      vowelAt.push(text.length);

      continue;
    }

    if (/\s/.test(char)) {
      if (text.length > 0 && !text.endsWith(' ')) {
        text += ' ';
      }

      continue;
    }

    text += char;
  }

  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
  }

  const stresses = vowelAt.map((vowel) => {
    let at = vowel;

    while (at > 0 && CYRILLIC_LETTER.test(text[at - 1] as string)) {
      at -= 1;
    }

    return { at, vowel: vowel - at };
  });

  return { text, stresses };
}

/**
 * Текст без знаков ударения и только без них: пробелы и переносы остаются как
 * набраны. Это форма для субтитра и подписи — там знак `+` был бы опечаткой.
 */
export function plainNarration(narration: string): string {
  let result = '';

  for (let index = 0; index < narration.length; index += 1) {
    if (!isStressMark(narration, index)) {
      result += narration[index];
    }
  }

  return result;
}

/**
 * Слова канонического текста: непрерывные цепочки кириллических букв со своей
 * позицией. Дефис делит слово на части — так словарь ударений применяется к
 * каждой части отдельно, и «по-разному» получает ударение из записи «р+азному».
 */
export function narrationWords(text: string): NarrationWord[] {
  const words: NarrationWord[] = [];

  for (const match of text.matchAll(/[а-яё]+/giu)) {
    words.push({ at: match.index, word: match[0] });
  }

  return words;
}

/** Граница UTF-16 не может стоять между двумя половинами surrogate pair. */
export function splitsUtf16Character(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) {
    return false;
  }

  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);

  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
}

/**
 * Явные замены применяются к канонической строке слева направо. Результат хранит
 * обе шкалы, чтобы паузы/акценты и измеренные слова можно было перевести обратно,
 * не меняя подпись и субтитр сцены.
 */
export function applyPronunciationReplacements(
  sourceText: string,
  replacements: readonly PronunciationTextReplacement[],
): AppliedPronunciationText {
  let text = '';
  let sourceAt = 0;

  const stresses: NarrationStress[] = [];
  const segments: PronunciationTextSegment[] = [];

  const append = (sourceFrom: number, sourceTo: number, output: string, replaced: boolean) => {
    const outputFrom = text.length;

    text += output;
    segments.push({
      sourceFrom,
      sourceTo,
      outputFrom,
      outputTo: text.length,
      replaced,
    });
  };

  for (const replacement of replacements) {
    if (replacement.from > sourceAt) {
      append(sourceAt, replacement.from, sourceText.slice(sourceAt, replacement.from), false);
    }

    const parsed = parseNarration(replacement.pronunciation);
    const outputFrom = text.length;

    append(replacement.from, replacement.to, parsed.text, true);
    stresses.push(...parsed.stresses.map((stress) => ({
      at: outputFrom + stress.at,
      vowel: stress.vowel,
    })));
    sourceAt = replacement.to;
  }

  if (sourceAt < sourceText.length) {
    append(sourceAt, sourceText.length, sourceText.slice(sourceAt), false);
  }

  if (segments.length === 0) {
    append(0, sourceText.length, sourceText, false);
  }

  return { sourceText, text, stresses, segments };
}

function safeOffset(text: string, at: number, edge: 'start' | 'end'): number {
  const bounded = Math.min(Math.max(Math.round(at), 0), text.length);

  if (!splitsUtf16Character(text, bounded)) {
    return bounded;
  }

  return edge === 'start' ? bounded - 1 : bounded + 1;
}

/** Переводит UTF-16 смещение исходной реплики в произносимую строку. */
export function pronunciationOutputOffset(
  applied: AppliedPronunciationText,
  sourceOffset: number,
  edge: 'start' | 'end' = 'start',
): number {
  const bounded = Math.min(Math.max(sourceOffset, 0), applied.sourceText.length);
  const segment = applied.segments.find((entry) => (
    bounded >= entry.sourceFrom && bounded <= entry.sourceTo
  )) ?? applied.segments.at(-1);

  if (!segment) {
    return 0;
  }

  if (!segment.replaced || segment.sourceTo === segment.sourceFrom) {
    return safeOffset(
      applied.text,
      segment.outputFrom + bounded - segment.sourceFrom,
      edge,
    );
  }

  if (bounded === segment.sourceFrom) {
    return segment.outputFrom;
  }

  if (bounded === segment.sourceTo) {
    return segment.outputTo;
  }

  const ratio = (bounded - segment.sourceFrom) / (segment.sourceTo - segment.sourceFrom);
  const scaled = segment.outputFrom + ratio * (segment.outputTo - segment.outputFrom);

  return safeOffset(applied.text, edge === 'start' ? Math.floor(scaled) : Math.ceil(scaled), edge);
}

/** Переводит измеренное смещение произносимой строки назад в экранный текст. */
export function pronunciationSourceOffset(
  applied: AppliedPronunciationText,
  outputOffset: number,
  edge: 'start' | 'end' = 'start',
): number {
  const bounded = Math.min(Math.max(outputOffset, 0), applied.text.length);
  const segment = applied.segments.find((entry) => (
    bounded >= entry.outputFrom && bounded <= entry.outputTo
  )) ?? applied.segments.at(-1);

  if (!segment) {
    return 0;
  }

  if (!segment.replaced || segment.outputTo === segment.outputFrom) {
    return safeOffset(
      applied.sourceText,
      segment.sourceFrom + bounded - segment.outputFrom,
      edge,
    );
  }

  if (bounded === segment.outputFrom) {
    return segment.sourceFrom;
  }

  if (bounded === segment.outputTo) {
    return segment.sourceTo;
  }

  const ratio = (bounded - segment.outputFrom) / (segment.outputTo - segment.outputFrom);
  const scaled = segment.sourceFrom + ratio * (segment.sourceTo - segment.sourceFrom);

  return safeOffset(
    applied.sourceText,
    edge === 'start' ? Math.floor(scaled) : Math.ceil(scaled),
    edge,
  );
}
