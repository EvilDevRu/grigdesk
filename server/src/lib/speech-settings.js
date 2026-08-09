import { createHash, randomUUID } from 'node:crypto';

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

export class SpeechSettingsInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpeechSettingsInputError';
    this.code = 'bad_speech_setting';
  }
}

export class SpeechSettingsConflictError extends Error {
  constructor(message = 'Настройки речи изменились в другом окне. Перечитайте их и подтвердите выбор заново.') {
    super(message);
    this.name = 'SpeechSettingsConflictError';
    this.code = 'stale_speech_settings';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function oneOf(value, allowed, key) {
  if (!allowed.has(value)) {
    throw new SpeechSettingsInputError(`Некорректное значение speech.${key}.`);
  }
  return value;
}

function boolean(value, key) {
  if (typeof value !== 'boolean') {
    throw new SpeechSettingsInputError(`speech.${key} должно быть boolean.`);
  }
  return value;
}

function nullableOneOf(value, allowed, key) {
  if (value === null) return null;
  return oneOf(value, allowed, key);
}

function integerInRange(value, min, max, key, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SpeechSettingsInputError(
      `speech.${key} должно быть целым числом от ${min} до ${max}.`,
    );
  }
  return value;
}

function dictionary(value) {
  if (typeof value !== 'string') {
    throw new SpeechSettingsInputError('speech.dictionary должно быть строкой.');
  }
  const normalized = value.replace(/\r\n?/g, '\n');
  if ([...normalized].length > 800) {
    throw new SpeechSettingsInputError('Словарь speech.dictionary не может быть длиннее 800 символов.');
  }
  return normalized;
}

function validateField(key, value, { stored = false } = {}) {
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
export function normalizeSpeechSettings(value) {
  const source = isPlainObject(value) ? value : {};
  const out = {};
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
export function validateSpeechPatch(value) {
  if (!isPlainObject(value)) {
    throw new SpeechSettingsInputError('Тело настройки речи должно быть JSON-объектом.');
  }
  const out = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!PATCH_KEYS.has(key)) {
      throw new SpeechSettingsInputError(`Неизвестная настройка speech.${key}.`);
    }
    out[key] = validateField(key, fieldValue);
  }
  return out;
}

export function createSpeechSettingsRevision() {
  return `speech:${randomUUID()}`;
}

/**
 * Сохранённая server revision переживает рестарт и различает ABA (A→B→A). До первой
 * speech-мутации, когда UUID ещё не записан, стабильную revision даёт хеш defaults.
 */
export function speechSettingsRevision(settings, storedRevision = null) {
  if (typeof storedRevision === 'string' && REVISION_RE.test(storedRevision)) {
    return storedRevision;
  }
  const normalized = normalizeSpeechSettings(settings);
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

function readStoredRevision(prefs) {
  try {
    return prefs.readStored?.().speech?.[STORED_REVISION_KEY] || null;
  } catch {
    return null;
  }
}

/**
 * Единственная read-modify-write секция для вложенного speech. Все операции синхронны:
 * между read и atomic rename event loop не может впустить второй HTTP-патч.
 */
export function updateSpeech(prefs, transform) {
  if (!prefs?.read || !prefs?.write || typeof transform !== 'function') {
    throw new TypeError('updateSpeech требует PrefsStore и функцию преобразования.');
  }
  const current = normalizeSpeechSettings(prefs.read().speech);
  const candidate = transform({ ...current });
  if (!isPlainObject(candidate)) {
    throw new TypeError('updateSpeech transform должен вернуть объект настроек.');
  }
  const next = normalizeSpeechSettings(candidate);
  const revision = createSpeechSettingsRevision();
  prefs.write({ speech: { ...next, [STORED_REVISION_KEY]: revision } });
  return { settings: next, revision };
}

export class SpeechSettingsStore {
  constructor({ prefs }) {
    if (!prefs?.read || !prefs?.write) throw new TypeError('SpeechSettingsStore требует PrefsStore.');
    this.prefs = prefs;
  }

  read() {
    const settings = normalizeSpeechSettings(this.prefs.read().speech);
    return {
      settings,
      revision: speechSettingsRevision(settings, readStoredRevision(this.prefs)),
    };
  }

  update(patch) {
    const accepted = validateSpeechPatch(patch);
    return updateSpeech(this.prefs, (current) => {
      const next = { ...current, ...accepted };
      // local — явный отказ от потенциально удалённого browser-auto. Возврат в auto
      // поэтому неизбежно проходит отдельный consent endpoint заново.
      if (accepted.browserProcessing === 'local') next.browserAutoConsent = false;
      return next;
    });
  }

  grantBrowserConsent({ confirm, revision } = {}) {
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
