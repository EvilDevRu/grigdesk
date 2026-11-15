import { parseNarration } from '../../shared/plugins/showcase/showcaseNarration.ts';
import type { NarrationStress } from '../../shared/plugins/showcase/showcaseNarration.ts';

import { VOICE_PACES } from './args.ts';

export { VOICE_PACES } from './args.ts';

export type VoicePace = typeof VOICE_PACES[number];
export type Stress = NarrationStress;
export type UnreadableKind = 'latin' | 'digits';

export interface ParsedVoiceText {
  canonicalText: string;
  stresses: Stress[];
}

export interface VoiceCapabilities {
  languages: readonly string[];
  pace: boolean;
  stress: boolean;
  stressMode?: 'experimental';
  instruction?: boolean;
  pause: boolean;
  tone: boolean;
  emphasis: boolean;
  maxChars: number;
  formats: readonly string[];
}

export interface VoiceInfo {
  id: string;
  name: string;
  languages: readonly string[];
  available: boolean;
  reason: string;
}

export interface VoiceDoctor {
  status: 'ready' | 'blocked';
  reason: string;
  install: string;
}

export interface SynthesisInput {
  text: string;
  voiceRef: string | null;
  language: string | null;
}

export interface SynthesisOptions {
  outputFile: string;
  format?: string;
  pace?: VoicePace | null;
  instruction?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SynthesisResult {
  file: string;
  bytes: number;
  format: 'wav';
  ignoredDirections: string[];
  warnings?: string[];
}

export interface VoiceDirection {
  pace?: VoicePace | null;
  stresses?: readonly Stress[];
  instruction?: string | null;
}

export interface VoiceEngine {
  id: string;
  name: string;
  model: string;
  defaultVoice: string;
  kind: 'local' | 'cloud';
  service?: string;
  capabilities(): VoiceCapabilities;
  doctor(): Promise<VoiceDoctor>;
  voices(): Promise<VoiceInfo[]>;
  synthesize(input: SynthesisInput, options: SynthesisOptions): Promise<SynthesisResult>;
}

/**
 * Ожидаемая безопасная ошибка несёт только объяснение для человека и код CLI.
 * Сырые transport error, HTTP body и cause в этот контракт не включаются.
 */
export class VoiceError extends Error {
  readonly exitCode: 1 | 2;

  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'VoiceError';
    this.exitCode = exitCode;
  }
}

/**
 * Использует единственный общий разбор ударений для сервера, браузера и CLI.
 * Позиции ударений относятся к уже нормализованному каноническому тексту.
 */
export function parseVoiceText(text: string): ParsedVoiceText {
  const parsed = parseNarration(text);

  return { canonicalText: parsed.text, stresses: parsed.stresses };
}

/**
 * Перечисляет только реально переданные, но неприменённые указания.
 * Поддержка инструкции принадлежит адаптеру; неподдержанное указание не исчезает молча.
 */
export function unsupportedDirections(
  direction: VoiceDirection,
  capabilities: VoiceCapabilities,
): string[] {
  const ignored: string[] = [];

  if (direction.pace && direction.pace !== 'normal' && !capabilities.pace) {
    ignored.push('темп');
  }

  if ((direction.stresses?.length ?? 0) > 0 && !capabilities.stress) {
    ignored.push('ударения');
  }

  if (direction.instruction?.trim() && !capabilities.instruction) {
    ignored.push('инструкция');
  }

  return ignored;
}

/**
 * Возвращает конкретные обрывки, которые локальная модель не прочитает.
 * Сохраняет регистр первого появления и не повторяет одинаковые обрывки.
 */
export function unreadableFragments(text: string, kinds: readonly UnreadableKind[]): string[] {
  const found: string[] = [];

  for (const match of text.matchAll(/[a-z0-9]+/giu)) {
    const kind: UnreadableKind = /[a-z]/iu.test(match[0]) ? 'latin' : 'digits';

    if (kinds.includes(kind) && !found.includes(match[0])) {
      found.push(match[0]);
    }
  }

  return found;
}

/**
 * Общая проверка выполняется адаптером до HTTP, doctor и дочернего синтеза.
 * Лимит относится к каноническому тексту; формат v1 не вызывает скрытую конвертацию.
 */
export function validateSynthesis(
  input: SynthesisInput,
  options: SynthesisOptions,
  capabilities: VoiceCapabilities,
): ParsedVoiceText {
  if (options.signal?.aborted) {
    throw new VoiceError('Операция отменена.');
  }

  if ((options.format ?? 'wav') !== 'wav' || !capabilities.formats.includes('wav')) {
    throw new VoiceError('Неподдержанный формат: в v1 доступен только wav.', 2);
  }

  if (options.pace && !VOICE_PACES.some((pace) => pace === options.pace)) {
    throw new VoiceError('Неизвестный темп речи.', 2);
  }

  if (input.language !== null && !capabilities.languages.includes(input.language)) {
    throw new VoiceError('Выбранный движок не поддерживает указанный язык.', 2);
  }

  const parsed = parseVoiceText(input.text);

  if (!parsed.canonicalText) {
    throw new VoiceError('Пустой текст для синтеза.', 2);
  }

  if (parsed.canonicalText.length > capabilities.maxChars) {
    throw new VoiceError(`Реплика длиннее предела движка: максимум ${capabilities.maxChars}.`, 2);
  }

  return parsed;
}
