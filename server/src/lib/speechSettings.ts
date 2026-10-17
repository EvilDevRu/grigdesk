import { createHash, randomUUID } from 'node:crypto';

import { isRecord } from '../../../shared/lib/objects.ts';

import { DEFAULT_VIDEO_INITIAL_PROMPT, INITIAL_PROMPT_MAX_CHARS } from './speech/options.ts';

// Поля nullable — именно ручные override: null означает «возьми значение из пресета».
// Дефолты хранятся рядом с валидатором, чтобы GET и запись не расходились.
export const SPEECH_DEFAULTS = Object.freeze({
  engine: 'browser',
  browserProcessing: 'auto',
  browserAutoConsent: false,
  language: 'ru',
  dictionary: '',
  quality: 'balanced',
  videoQuality: 'balanced',
  videoInitialPrompt: DEFAULT_VIDEO_INITIAL_PROMPT,
  model: null,
  videoModel: null,
  device: 'auto',
  computeType: null,
  beamSize: null,
  vadSilenceMs: 500,
  conditionOnPreviousText: true,
  resident: false,
  keepAliveMin: 5,
});

const PATCH_KEYS = new Set(Object.keys(SPEECH_DEFAULTS));
const ENGINES = new Set(['whisper', 'browser']);
const BROWSER_PROCESSING = new Set(['auto', 'local']);
const LANGUAGES = new Set(['ru', 'en', 'auto']);
const QUALITIES = new Set(['fast', 'balanced', 'accurate']);
const MODELS = new Set(['small', 'medium', 'large-v3', 'large-v3-turbo']);
const DEVICES = new Set(['auto', 'cpu', 'cuda']);
const COMPUTE_TYPES = new Set(['int8', 'int8_float16', 'float16', 'float32']);
const STORED_REVISION_KEY = '_revision';
const REVISION_RE = /^speech:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Нормализованные настройки речи: ровно ключи SPEECH_DEFAULTS, чужого не остаётся.
export type SpeechSettings = Record<string, unknown>;

// Снимок настроек вместе с ревизией, по которой сверяется параллельная правка.
export interface SpeechSettingsSnapshot {
  settings: SpeechSettings;
  revision: string;
}

// Что нужно от ещё нетипизированного стора настроек.
export interface SpeechPrefsPort {
  read: () => Record<string, unknown>;
  write: (patch: Record<string, unknown>) => unknown;
  readStored?: () => Record<string, unknown>;
}

export class SpeechSettingsInputError extends Error {
  readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = 'SpeechSettingsInputError';
    this.code = 'bad_speech_setting';
  }
}

export class SpeechSettingsConflictError extends Error {
  readonly code: string;

  constructor(message = 'Настройки речи изменились в другом окне. Перечитайте их и подтвердите выбор заново.') {
    super(message);
    this.name = 'SpeechSettingsConflictError';
    this.code = 'stale_speech_settings';
  }
}

function oneOf(value: unknown, allowed: Set<string>, key: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new SpeechSettingsInputError(`Некорректное значение speech.${key}.`);
  }
  return value;
}

function boolean(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SpeechSettingsInputError(`speech.${key} должно быть boolean.`);
  }
  return value;
}

function nullableOneOf(value: unknown, allowed: Set<string>, key: string): string | null {
  if (value === null) return null;
  return oneOf(value, allowed, key);
}

function integerInRange(
  value: unknown,
  min: number,
  max: number,
  key: string,
  { nullable = false } = {},
): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new SpeechSettingsInputError(
      `speech.${key} должно быть целым числом от ${min} до ${max}.`,
    );
  }
  return value;
}

function dictionary(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SpeechSettingsInputError('speech.dictionary должно быть строкой.');
  }
  const normalized = value.replace(/\r\n?/g, '\n');
  if ([...normalized].length > 800) {
    throw new SpeechSettingsInputError('Словарь speech.dictionary не может быть длиннее 800 символов.');
  }
  return normalized;
}

/**
 * Пустая строка допустима и означает «без подсказки»: очистка поля — осознанный выбор
 * человека, и подставлять дефолт обратно нельзя, иначе поле не выключить.
 */
function initialPrompt(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SpeechSettingsInputError('speech.videoInitialPrompt должно быть строкой.');
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if ([...normalized].length > INITIAL_PROMPT_MAX_CHARS) {
    throw new SpeechSettingsInputError(
      `speech.videoInitialPrompt не может быть длиннее ${INITIAL_PROMPT_MAX_CHARS} символов.`,
    );
  }
  return normalized;
}

function validateField(
  key: string,
  value: unknown,
  { stored = false } = {},
): string | number | boolean | null {
  switch (key) {
    case 'engine': return oneOf(value, ENGINES, key);
    case 'browserProcessing': return oneOf(value, BROWSER_PROCESSING, key);
    case 'browserAutoConsent':
      if (!stored && value === true) {
        throw new SpeechSettingsInputError(
          'Разрешение browser-auto выдаётся только через /api/settings/speech/browser-consent.',
        );
      }
      return boolean(value, key);
    case 'language': return oneOf(value, LANGUAGES, key);
    case 'dictionary': return dictionary(value);
    case 'quality':
    case 'videoQuality': return oneOf(value, QUALITIES, key);
    // null — «вернуть стандартную подсказку». Так кнопка сброса в UI не обязана хранить
    // вторую копию текста промпта и не разойдётся с серверной при правке.
    case 'videoInitialPrompt':
      return value === null ? DEFAULT_VIDEO_INITIAL_PROMPT : initialPrompt(value);
    case 'model':
    case 'videoModel': return nullableOneOf(value, MODELS, key);
    case 'device': return oneOf(value, DEVICES, key);
    case 'computeType': return nullableOneOf(value, COMPUTE_TYPES, key);
    case 'beamSize': return integerInRange(value, 1, 10, key, { nullable: true });
    case 'vadSilenceMs': return integerInRange(value, 100, 5000, key);
    case 'conditionOnPreviousText':
    case 'resident': return boolean(value, key);
    case 'keepAliveMin': return integerInRange(value, 0, 60, key);
    default: throw new SpeechSettingsInputError(`Неизвестная настройка speech.${key}.`);
  }
}

/**
 * Нормализовать сохранённый объект. Битое отдельное поле возвращается к своему default,
 * а неизвестные поля не попадают ни в публичный снимок, ни в следующую запись.
 */
export function normalizeSpeechSettings(value: unknown): SpeechSettings {
  const source = isRecord(value) ? value : {};
  const out: SpeechSettings = {};
  for (const [key, fallback] of Object.entries(SPEECH_DEFAULTS)) {
    if (!(key in source)) {
      out[key] = fallback;
      continue;
    }
    try {
      out[key] = validateField(key, source[key], { stored: true });
    } catch {
      out[key] = fallback;
    }
  }
  return out;
}

/** Строгая проверка частичного HTTP-патча: неизвестное не отбрасывается молча. */
export function validateSpeechPatch(value: unknown): SpeechSettings {
  if (!isRecord(value)) {
    throw new SpeechSettingsInputError('Тело настройки речи должно быть JSON-объектом.');
  }
  const out: SpeechSettings = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!PATCH_KEYS.has(key)) {
      throw new SpeechSettingsInputError(`Неизвестная настройка speech.${key}.`);
    }
    out[key] = validateField(key, fieldValue);
  }
  return out;
}

export function createSpeechSettingsRevision(): string {
  return `speech:${randomUUID()}`;
}

/**
 * Сохранённая server revision переживает рестарт и различает ABA (A→B→A). До первой
 * speech-мутации, когда UUID ещё не записан, стабильную revision даёт хеш defaults.
 */
export function speechSettingsRevision(settings: unknown, storedRevision: unknown = null): string {
  if (typeof storedRevision === 'string' && REVISION_RE.test(storedRevision)) {
    return storedRevision;
  }
  const normalized = normalizeSpeechSettings(settings);
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

function readStoredRevision(prefs: SpeechPrefsPort): string | null {
  try {
    const speech = prefs.readStored?.().speech as Record<string, unknown> | undefined;

    return (speech?.[STORED_REVISION_KEY] as string | undefined) || null;
  } catch {
    return null;
  }
}

/**
 * Единственная read-modify-write секция для вложенного speech. Все операции синхронны:
 * между read и atomic rename event loop не может впустить второй HTTP-патч.
 */
export function updateSpeech(
  prefs: SpeechPrefsPort | null | undefined,
  transform: (current: SpeechSettings) => unknown,
): SpeechSettingsSnapshot {
  if (!prefs?.read || !prefs?.write || typeof transform !== 'function') {
    throw new TypeError('updateSpeech требует PrefsStore и функцию преобразования.');
  }
  const current = normalizeSpeechSettings(prefs.read().speech);
  const candidate = transform({ ...current });
  if (!isRecord(candidate)) {
    throw new TypeError('updateSpeech transform должен вернуть объект настроек.');
  }
  const next = normalizeSpeechSettings(candidate);
  const revision = createSpeechSettingsRevision();
  prefs.write({ speech: { ...next, [STORED_REVISION_KEY]: revision } });
  return { settings: next, revision };
}

export class SpeechSettingsStore {
  readonly prefs: SpeechPrefsPort;

  constructor({ prefs }: { prefs: SpeechPrefsPort }) {
    if (!prefs?.read || !prefs?.write) throw new TypeError('SpeechSettingsStore требует PrefsStore.');
    this.prefs = prefs;
  }

  read(): SpeechSettingsSnapshot {
    const settings = normalizeSpeechSettings(this.prefs.read().speech);
    return {
      settings,
      revision: speechSettingsRevision(settings, readStoredRevision(this.prefs)),
    };
  }

  update(patch: unknown): SpeechSettingsSnapshot {
    const accepted = validateSpeechPatch(patch);
    return updateSpeech(this.prefs, (current) => {
      const next = { ...current, ...accepted };
      // local — явный отказ от потенциально удалённого browser-auto. Возврат в auto
      // поэтому неизбежно проходит отдельный consent endpoint заново.
      if (accepted.browserProcessing === 'local') next.browserAutoConsent = false;
      return next;
    });
  }

  grantBrowserConsent({ confirm, revision }: {
    confirm?: unknown;
    revision?: unknown;
  } = {}): SpeechSettingsSnapshot {
    if (confirm !== true) {
      throw new SpeechSettingsInputError('Подтверждение browser-auto требует confirm=true.');
    }
    const current = this.read();
    if (typeof revision !== 'string' || revision !== current.revision) {
      throw new SpeechSettingsConflictError();
    }
    if (current.settings.engine !== 'browser' || current.settings.browserProcessing !== 'auto') {
      throw new SpeechSettingsConflictError(
        'Согласие применимо только к актуально выбранному режиму browser:auto.',
      );
    }
    // Endpoint одновременно служит fail-closed validation перед каждым запуском
    // browser:auto. Уже выданное согласие подтверждаем без смены revision: иначе
    // одна диктовка искусственно делала stale все остальные открытые окна.
    if (current.settings.browserAutoConsent) return current;
    return updateSpeech(this.prefs, (settings) => ({
      ...settings,
      browserAutoConsent: true,
    }));
  }
}
