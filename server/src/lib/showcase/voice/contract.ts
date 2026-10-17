// Контракт голосового движка.
//
// Ядро хранит НЕЙТРАЛЬНЫЕ указания: тон, темп, акценты, паузы и ударения. Каждый
// адаптер сам переводит их в свою разметку — общей таблицы с ветками по вендорам
// в ядре нет, иначе новый движок пришлось бы вписывать в чужой код.
//
// Длительность, хеш содержимого и идентификатор считает служба по готовому файлу.
// Верить размеру и ревизии, которые вернул поставщик, нельзя: это его слова о
// своём результате, а не проверенный факт.
import { parseNarration } from '../../../../../shared/plugins/showcase/showcaseNarration.ts';
import type { ShowcasePace } from '../../../../../shared/plugins/showcase/showcaseContracts.ts';

export type VoicePace = ShowcasePace;

// Чего движок не прочитает: латинские буквы и цифры молча выпадают из речи или
// роняют синтез, поэтому такой текст отвергается до задания, а не после.
export type UnreadableKind = 'latin' | 'digits';

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
  unreadable?: UnreadableKind[];
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  // Недоступный ранее выбранный голос остаётся видимым с причиной: тихая подмена
  // другим голосом посреди ролика хуже честного отказа.
  available: boolean;
  reason: string;
  // У некоторых поставщиков возможности зависят от диктора. Адаптер может не
  // знать их до каталога; registry дополняет поле перед публичным ответом.
  capabilities?: Pick<VoiceCapabilities, 'pace' | 'pause' | 'stress'>;
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
  pace: VoicePace | null;
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

// Нативная временная метка уже приведена адаптером к общей шкале WAV. Здесь нет
// индексов канонического текста: последовательное сопоставление с повторами и
// «ё/е» выполняется отдельно и не должно угадываться внутри поставщика голоса.
export interface VoiceSpeechSpanTiming {
  text: string;
  startMs: number;
  endMs: number;
}

export interface VoiceSpeechTiming {
  source: 'edge' | 'yandex';
  readonly words: readonly VoiceSpeechSpanTiming[];
  readonly segments: readonly VoiceSpeechSpanTiming[];
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
  // Старые и локальные движки вправе не вернуть метки. Их отсутствие не меняет
  // голос и не запускает синтез повторно: следующий слой выберет ASR/fallback.
  speechTiming?: VoiceSpeechTiming;
}

export interface SynthesisOptions {
  signal?: AbortSignal;
  deadlineMs: number;
  outputDir: string;
}

// Сколько реплик движок принимает одним вызовом сеанса: по числу и по сумме
// знаков. Предел по знакам держит видеопамять — батч растёт с длиной речи.
export interface VoiceBatchLimit {
  items: number;
  chars: number;
}

/**
 * Сеанс синтеза на одно задание. Движок с тяжёлой моделью поднимает её один раз
 * на все реплики задания, а не на каждую: подъём процесса стоил дороже самого
 * синтеза. Между заданиями сеанса нет — видеопамять и память свободны, как раньше.
 * Реплики идут списком: движок, умеющий батч, отдаёт несколько за время одной.
 */
export interface VoiceSession {
  // null — реплики только по одной.
  batch: VoiceBatchLimit | null;
  synthesize(inputs: SynthesisInput[], options: SynthesisOptions): Promise<VoiceCandidate[]>;
  close(): Promise<void>;
}

export interface VoiceEngine {
  id: string;
  name: string;
  kind: 'local' | 'cloud';
  capabilities(voiceRef: string | null): VoiceCapabilities;
  doctor(): Promise<VoiceDoctor>;
  // Локальные движки кэшируют проверку окружения. После установки кэш обязан
  // забыться сразу: событие «голос установлен» иначе показало бы прежнее
  // «модель не скачана» до истечения кэша.
  forgetDoctor?(): void;
  voices(): Promise<VoiceInfo[]>;
  synthesize(input: SynthesisInput, options: SynthesisOptions): Promise<VoiceCandidate>;
  // Сеанс на задание есть только у движков с резидентным процессом; остальные
  // получают обёртку над одиночным синтезом через `openVoiceSession`.
  openSession?(): Promise<VoiceSession>;
}

/**
 * Сеанс для любого движка: свой, если движок его даёт, иначе обёртка над
 * одиночным синтезом по одной реплике. Озвучка работает с сеансом всегда и не
 * ветвится по тому, есть ли у движка резидентный процесс.
 */
export async function openVoiceSession(engine: VoiceEngine): Promise<VoiceSession> {
  if (engine.openSession) {
    return engine.openSession();
  }

  return {
    batch: null,
    async synthesize(inputs, options) {
      const candidates: VoiceCandidate[] = [];

      for (const input of inputs) {
        candidates.push(await engine.synthesize(input, options));
      }

      return candidates;
    },
    async close() {
      // Резидентного процесса нет — закрывать нечего.
    },
  };
}

/**
 * Канонический текст для синтеза: знаки ударения сняты, пробелы схлопнуты. Сами
 * ударения разбираются в структуру `direction` отдельно — движок получает обычный
 * текст и указания рядом, а не два независимых источника разметки в одной строке.
 */
export function canonicalTextOf(narration: string): string {
  return parseNarration(narration).text;
}

/**
 * Обрывки текста, которые движок не прочитает: цепочки латинских букв и цифр.
 * Возвращаются сами обрывки, а не флаг: человеку нужно видеть, ЧТО переписать
 * словами, — «API» и «2026», а не «в тексте есть латиница».
 */
export function unreadableFragments(text: string, unreadable: UnreadableKind[] | undefined): string[] {
  if (!unreadable || unreadable.length === 0) {
    return [];
  }

  const found: string[] = [];

  for (const match of text.matchAll(/[a-z0-9]+/gi)) {
    const kind: UnreadableKind = /[a-z]/i.test(match[0]) ? 'latin' : 'digits';

    if (unreadable.includes(kind) && !found.includes(match[0])) {
      found.push(match[0]);
    }
  }

  return found;
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
