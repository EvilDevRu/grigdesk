// Контракт голосового движка.
//
// Ядро хранит НЕЙТРАЛЬНЫЕ указания: тон, темп, акценты, паузы и ударения. Каждый
// адаптер сам переводит их в свою разметку — общей таблицы с ветками по вендорам
// в ядре нет, иначе новый движок пришлось бы вписывать в чужой код.
//
// Длительность, хеш содержимого и идентификатор считает служба по готовому файлу.
// Верить размеру и ревизии, которые вернул поставщик, нельзя: это его слова о
// своём результате, а не проверенный факт.

export interface VoiceCapabilities {
  languages: string[];
  tone: boolean;
  pace: boolean;
  emphasis: boolean;
  pause: boolean;
  stress: boolean;
  maxChars: number;
  supportedFormats: string[];
  engineVersion: string;
  modelRevision: string | null;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  // Недоступный ранее выбранный голос остаётся видимым с причиной: тихая подмена
  // другим голосом посреди ролика хуже честного отказа.
  available: boolean;
  reason: string;
}

export interface VoiceDoctor {
  status: 'ready' | 'blocked' | 'unknown';
  reason: string;
  // Установка движка и весов — отдельное действие настройки. Doctor только
  // сообщает, чего не хватает, и ничего не скачивает.
  install: string;
}

export interface VoiceDirection {
  tone: string | null;
  pace: 'slow' | 'normal' | 'fast' | null;
  emphasis: { from: number; to: number }[];
  pauses: { at: number; ms: number }[];
  stresses: { at: number; vowel: number }[];
}

export interface SynthesisInput {
  canonicalText: string;
  direction: VoiceDirection;
  voiceRef: string | null;
  language: string;
}

export interface VoiceCandidate {
  temporaryFile: string;
  format: string;
  sampleRate: number;
  channels: number;
  // Идентификатор запроса поставщика нужен для разбора неопределённого исхода:
  // по нему человек находит оплаченный вызов, если ответ потерялся.
  engineRequestId: string | null;
  // Указания, которые движок не поддержал. Молча терять их нельзя: человек
  // услышит не то, что просил, и не поймёт почему.
  ignoredDirections: string[];
}

export interface SynthesisOptions {
  signal?: AbortSignal;
  deadlineMs: number;
  outputDir: string;
}

export interface VoiceEngine {
  id: string;
  name: string;
  kind: 'local' | 'cloud';
  capabilities(voiceRef: string | null): VoiceCapabilities;
  doctor(): Promise<VoiceDoctor>;
  voices(): Promise<VoiceInfo[]>;
  synthesize(input: SynthesisInput, options: SynthesisOptions): Promise<VoiceCandidate>;
}

/**
 * Канонический текст для синтеза. Знаки ударения и паузы из формы ввода уже разобраны
 * в структуру `direction`, поэтому здесь остаётся обычный текст: два независимых
 * источника пауз (разметка в строке и структура рядом) неминуемо разошлись бы.
 */
export function canonicalTextOf(narration: string): string {
  return narration.replace(/\s+/g, ' ').trim();
}

/**
 * Указания, которые движок объявил неподдерживаемыми. Список нужен адаптерам,
 * чтобы вернуть его в кандидате: предупреждение с конкретикой полезнее общего
 * «часть настроек не применена».
 */
export function unsupportedDirections(
  direction: VoiceDirection,
  capabilities: VoiceCapabilities,
): string[] {
  const ignored: string[] = [];

  if (direction.tone && !capabilities.tone) {
    ignored.push('тон');
  }

  if (direction.pace && direction.pace !== 'normal' && !capabilities.pace) {
    ignored.push('темп');
  }

  if (direction.emphasis.length > 0 && !capabilities.emphasis) {
    ignored.push('акценты');
  }

  if (direction.pauses.length > 0 && !capabilities.pause) {
    ignored.push('паузы');
  }

  if (direction.stresses.length > 0 && !capabilities.stress) {
    ignored.push('ударения');
  }

  return ignored;
}
