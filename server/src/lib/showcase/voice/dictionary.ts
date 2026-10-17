// Словарь ударений установки.
//
// Одно слово со знаком `+` на строку (`дин+амика`), строки с `#` — комментарии,
// регистр не важен, «ё» и «е» различаются как набраны. Словарь применяется к
// словам канонического текста, у которых нет явного `+` в самой сцене: знак в
// тексте сильнее словаря, потому что он поставлен для этого места.
//
// Словарь живёт в памяти службы и перечитывается после сохранения: в хеш звука
// сцены входят ударения, которые словарь ДОБАВИЛ именно этому тексту, а хеш
// считается синхронно. Так правка словаря старит только сцены с этими словами,
// а не все ролики разом.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { narrationWords } from '../../../../../shared/plugins/showcase/showcaseNarration.ts';
import type { NarrationStress } from '../../../../../shared/plugins/showcase/showcaseNarration.ts';
import { ShowcaseError } from '../errors.ts';

export interface StressEntry {
  // Слово в нижнем регистре без знака и сдвиг ударной гласной от его начала.
  word: string;
  vowel: number;
}

export interface StressDictionaryLineError {
  line: number;
  text: string;
  reason: string;
}

export interface ParsedStressDictionary {
  entries: StressEntry[];
  errors: StressDictionaryLineError[];
}

export interface StressDictionarySnapshot {
  text: string;
  // Записи в канонической записи со знаком: человеку они читаются как строки
  // словаря, а не как пары «слово — номер буквы».
  entries: string[];
  errors: StressDictionaryLineError[];
}

// Предел текста словаря. Он не про память: словарь целиком уходит в ответ ручки
// и в редактор, и мегабайтный файл там — не словарь, а ошибка.
export const STRESS_DICTIONARY_MAX_BYTES = 64 * 1024;

const VOWELS = new Set('аеёиоуыэюя');

/**
 * Одна строка словаря. Негодная строка называется своей причиной и пропускается,
 * остальные применяются: одна опечатка не должна отключать весь словарь.
 */
function parseLine(source: string): { entry: StressEntry | null; reason: string } {
  const marks = source.split('+').length - 1;

  if (marks === 0) {
    return { entry: null, reason: 'нет знака ударения «+»' };
  }

  if (marks > 1) {
    return { entry: null, reason: 'нужен ровно один знак «+»' };
  }

  const word = source.replace('+', '').toLowerCase();

  if (!/^[а-яё]+$/u.test(word)) {
    return { entry: null, reason: 'слово должно состоять только из русских букв' };
  }

  const vowel = source.indexOf('+');

  if (!VOWELS.has(word[vowel] ?? '')) {
    return { entry: null, reason: 'знак «+» должен стоять перед гласной' };
  }

  return { entry: { word, vowel }, reason: '' };
}

/**
 * Разбор всего текста словаря. Повтор слова побеждает более поздней записью:
 * человек дописывает поправки в конец, а не ищет старую строку.
 */
export function parseStressDictionary(text: string): ParsedStressDictionary {
  const byWord = new Map<string, StressEntry>();
  const errors: StressDictionaryLineError[] = [];

  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*$/u, '').trim();

    if (!line) {
      return;
    }

    const { entry, reason } = parseLine(line);

    if (!entry) {
      errors.push({ line: index + 1, text: line, reason });

      return;
    }

    byWord.set(entry.word, entry);
  });

  return { entries: [...byWord.values()], errors };
}

export function markedEntry(entry: StressEntry): string {
  return `${entry.word.slice(0, entry.vowel)}+${entry.word.slice(entry.vowel)}`;
}

/**
 * Ударения из словаря для канонического текста. Слово с явным знаком в сцене
 * словарём не трогается: `explicitStarts` — начала таких слов. Сравнение идёт по
 * буквам без учёта регистра, «ё» остаётся «ё».
 */
export function dictionaryStresses(
  canonicalText: string,
  entries: readonly StressEntry[],
  explicitStarts: Iterable<number> = [],
): NarrationStress[] {
  if (entries.length === 0) {
    return [];
  }

  const byWord = new Map(entries.map((entry) => [entry.word, entry.vowel]));
  const explicit = new Set(explicitStarts);
  const stresses: NarrationStress[] = [];

  for (const { at, word } of narrationWords(canonicalText)) {
    const vowel = byWord.get(word.toLowerCase());

    if (vowel !== undefined && !explicit.has(at)) {
      stresses.push({ at, vowel });
    }
  }

  return stresses;
}

export interface StressDictionaryStoreOptions {
  file: string;
}

/**
 * Файл словаря и его разобранная копия в памяти. Читается при старте и после
 * каждого сохранения; `entries()` синхронный, потому что его зовёт хеш входов
 * звука, а тот считается без ожиданий на каждом чтении ролика.
 */
export function createStressDictionaryStore(options: StressDictionaryStoreOptions) {
  let text = '';
  let parsed: ParsedStressDictionary = { entries: [], errors: [] };
  let loaded = false;

  function snapshot(): StressDictionarySnapshot {
    return {
      text,
      entries: parsed.entries.map(markedEntry),
      errors: parsed.errors,
    };
  }

  async function load(): Promise<StressDictionarySnapshot> {
    text = await fs.readFile(options.file, 'utf8').catch(() => '');
    parsed = parseStressDictionary(text);
    loaded = true;

    return snapshot();
  }

  async function read(): Promise<StressDictionarySnapshot> {
    if (!loaded) {
      await load();
    }

    return snapshot();
  }

  /**
   * Сохраняется текст целиком, вместе с негодными строками: человек правит их в
   * редакторе, а не теряет при первом же сохранении. Запись атомарная — читатель
   * не увидит половину словаря.
   */
  async function save(next: string): Promise<StressDictionarySnapshot> {
    if (Buffer.byteLength(next, 'utf8') > STRESS_DICTIONARY_MAX_BYTES) {
      throw new ShowcaseError(
        'dictionary_too_long',
        `Словарь ударений длиннее ${STRESS_DICTIONARY_MAX_BYTES / 1024} КБ.`,
        413,
      );
    }

    await fs.mkdir(path.dirname(options.file), { recursive: true, mode: 0o700 });

    const temporary = `${options.file}.tmp`;

    await fs.writeFile(temporary, next, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, options.file);

    return load();
  }

  function entries(): readonly StressEntry[] {
    return parsed.entries;
  }

  return { entries, load, read, save };
}

export type StressDictionaryStore = ReturnType<typeof createStressDictionaryStore>;
