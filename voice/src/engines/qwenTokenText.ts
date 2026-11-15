import { VoiceError } from '../contract.ts';
import type { ParsedVoiceText } from '../contract.ts';

const LANGUAGES: Readonly<Record<string, string>> = {
  ru: 'Russian',
  en: 'English',
  zh: 'Chinese',
};

/**
 * Переводит общий плюс в U+0301 после гласной, сохраняя уже введённые Unicode-ударения.
 * Позиции общего парсера относятся к канонической строке, поэтому вставки идут справа налево.
 */
export function qwenTokenText(prepared: ParsedVoiceText): string {
  let text = prepared.canonicalText;
  const positions = [...new Set(prepared.stresses.map((stress) => stress.at + stress.vowel + 1))];

  for (const at of positions.sort((left, right) => right - left)) {
    if (text[at] !== '\u0301') {
      text = `${text.slice(0, at)}\u0301${text.slice(at)}`;
    }
  }

  return text;
}

/**
 * Усиливает размеченные слова подсказкой, сохраняя пользовательскую инструкцию отдельно.
 * Ограничение всей инструкции проверяется до платного запроса; тихого обрезания нет.
 */
export function qwenTokenInstruction(text: string, language: string, instruction?: string | null): string {
  const parts = [`Speak ${LANGUAGES[language]} naturally. Read only the provided text.`];

  if (text.includes('\u0301')) {
    const words = [...new Set(text.match(/[а-яё]+\u0301[а-яё]*/giu) ?? [])].slice(0, 12);

    parts.push('Follow the acute accent marks: stress the marked vowel. Do not read explanations.');

    if (words.length > 0) {
      parts.push(`Intended pronunciations: ${words.join(', ')}.`);
    }
  }

  if (instruction?.trim()) {
    parts.push(instruction.trim());
  }

  const combined = parts.join(' ');

  if (combined.length > 1600) {
    throw new VoiceError('Инструкция вместе с подсказкой ударений длиннее 1600 символов.', 2);
  }

  return combined;
}
