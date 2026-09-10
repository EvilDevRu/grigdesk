import { isSpeechModelId } from './catalog.ts';

export const SPEECH_PRESETS = Object.freeze({
  fast: Object.freeze({ model: 'small', beamSize: 1 }),
  balanced: Object.freeze({ model: 'medium', beamSize: 5 }),
  accurate: Object.freeze({ model: 'large-v3-turbo', beamSize: 5 }),
});

export const SPEECH_SCENARIOS = Object.freeze(['dictation', 'video']);

// Полный набор параметров одного запуска распознавания.
export interface SpeechOptions {
  scenario: string;
  model: string;
  language: string;
  device: string;
  computeType: string;
  beamSize: number;
  hotwords: string;
  vadSilenceMs: number;
  conditionOnPreviousText: boolean;
  initialPrompt: string;
}

// Настройки речи как их хранит prefs: любое поле может отсутствовать или быть чужим.
export type SpeechSettingsInput = Record<string, unknown>;

/**
 * Стилевая подсказка первому окну распознавания. Без неё модель на первом же сегменте
 * срывается в текст без пунктуации, а перенос контекста закрепляет этот стиль до конца
 * записи — так семнадцать минут встречи превращались в один сплошной поток слов.
 *
 * Короткий заголовок здесь не стилистика, а единственная безопасная форма: whisper
 * получает промпт как УЖЕ СКАЗАННЫЙ текст и продолжает его. Заголовок с точкой
 * продолжается речью, а инструкция вроде «реплики записаны с пунктуацией и заглавными
 * буквами» продолжается такой же инструкцией — замер на этой же записи дал четыре
 * сегмента «Реплика участников записаны с пунктами» вместо разговора. Формулировку
 * менять только с проверкой на реальном файле.
 *
 * Промпт не является словарём терминов: для них есть отдельный hotwords.
 */
export const DEFAULT_VIDEO_INITIAL_PROMPT = 'Стенограмма рабочей встречи.';

export const INITIAL_PROMPT_MAX_CHARS = 600;

const LANGUAGES = new Set(['ru', 'en', 'auto']);
const DEVICES = new Set(['auto', 'cpu', 'cuda']);
const COMPUTE_TYPES = new Set([
  'default',
  'auto',
  'int8',
  'int8_float16',
  'int8_float32',
  'int16',
  'float16',
  'float32',
  'bfloat16',
]);

function speechSettings(value: unknown): SpeechSettingsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as SpeechSettingsInput;
  if (source.speech && typeof source.speech === 'object' && !Array.isArray(source.speech)) {
    return source.speech as SpeechSettingsInput;
  }
  return source;
}

function enumValue(
  value: unknown,
  fallback: string,
  allowed: Set<string>,
  field: string,
): string {
  const selected = value ?? fallback;
  if (typeof selected !== 'string' || !allowed.has(selected)) {
    throw new TypeError(`Некорректное значение speech.${field}: ${String(selected)}`);
  }
  return selected;
}

function nullableModel(value: unknown, field: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !isSpeechModelId(value)) {
    throw new TypeError(`Неизвестная модель в speech.${field}: ${String(value)}`);
  }
  return value;
}

function integerValue(value: unknown, fallback: number, { min, max, field }: {
  min: number;
  max: number;
  field: string;
}): number {
  const selected = value ?? fallback;
  if (typeof selected !== 'number' || !Number.isInteger(selected)
    || selected < min || selected > max) {
    throw new TypeError(`speech.${field} должен быть целым от ${min} до ${max}`);
  }
  return selected;
}

function booleanValue(value: unknown, fallback: boolean, field: string): boolean {
  const selected = value ?? fallback;
  if (typeof selected !== 'boolean') {
    throw new TypeError(`speech.${field} должен быть boolean`);
  }
  return selected;
}

function hotwordsValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw new TypeError('speech.dictionary должен быть строкой');
  }
  return value.trim();
}

/**
 * Подсказка уезжает в argv Python, поэтому переводы строк схлопываются: многострочное
 * значение сломало бы разбор ответа и ничего не дало бы самой модели.
 */
function initialPromptValue(value: unknown, field: string): string {
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw new TypeError(`speech.${field} должен быть строкой`);
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if ([...cleaned].length > INITIAL_PROMPT_MAX_CHARS) {
    throw new TypeError(`speech.${field} не может быть длиннее ${INITIAL_PROMPT_MAX_CHARS} символов`);
  }
  return cleaned;
}

function assertScenario(scenario: unknown): asserts scenario is string {
  if (typeof scenario !== 'string' || !SPEECH_SCENARIOS.includes(scenario)) {
    throw new TypeError(`Неизвестный сценарий речи: ${String(scenario)}`);
  }
}

function defaultComputeType(device: string): string {
  if (device === 'cuda') return 'float16';
  if (device === 'auto') return 'auto';
  return 'int8';
}

/**
 * Разрешает настройки в полный набор параметров одного запуска.
 * Продвинутые model/beam/vad/condition относятся только к диктовке; для видео
 * существует отдельный videoModel, чтобы сценарии не переопределяли друг друга.
 */
export function resolveSpeechOptions(
  settings: unknown = {},
  scenario = 'dictation',
): SpeechOptions {
  assertScenario(scenario);
  const source = speechSettings(settings);
  const qualityField = scenario === 'video' ? 'videoQuality' : 'quality';
  const quality = enumValue(source[qualityField], 'balanced', new Set(Object.keys(SPEECH_PRESETS)), qualityField);
  const presets = SPEECH_PRESETS as Record<string, { model: string; beamSize: number } | undefined>;
  const preset = presets[quality] ?? SPEECH_PRESETS.balanced;
  const modelOverride = scenario === 'video'
    ? nullableModel(source.videoModel, 'videoModel')
    : nullableModel(source.model, 'model');
  const device = enumValue(source.device, 'cpu', DEVICES, 'device');
  const computeType = source.computeType == null || source.computeType === ''
    ? defaultComputeType(device)
    : enumValue(source.computeType, 'int8', COMPUTE_TYPES, 'computeType');

  return Object.freeze({
    scenario,
    model: modelOverride || preset.model,
    language: enumValue(source.language, 'ru', LANGUAGES, 'language'),
    device,
    computeType,
    beamSize: scenario === 'dictation'
      ? integerValue(source.beamSize, preset.beamSize, { min: 1, max: 20, field: 'beamSize' })
      : preset.beamSize,
    hotwords: hotwordsValue(source.dictionary ?? source.hotwords),
    vadSilenceMs: scenario === 'dictation'
      ? integerValue(source.vadSilenceMs, 500, { min: 0, max: 10_000, field: 'vadSilenceMs' })
      : 500,
    conditionOnPreviousText: scenario === 'dictation'
      ? booleanValue(source.conditionOnPreviousText, true, 'conditionOnPreviousText')
      : true,
    // Только у видео: там ход длинный, перенос контекста включён всегда, и стиль первого
    // сегмента определяет всю расшифровку. Диктовка короткая и правится руками на месте,
    // поэтому подсказка ей не назначается и поле сценариями не делится.
    initialPrompt: scenario === 'video'
      ? initialPromptValue(
        source.videoInitialPrompt ?? DEFAULT_VIDEO_INITIAL_PROMPT,
        'videoInitialPrompt',
      )
      : '',
  });
}

/**
 * Нормализует уже разрешённые options на transport-границе. В отличие от resolver,
 * здесь model относится именно к текущему запуску и не переинтерпретируется как
 * dictation/video override.
 */
export function normalizeSpeechOptions(
  options: unknown = {},
  fallbackScenario = 'dictation',
): SpeechOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Параметры речи должны быть объектом');
  }
  const source = options as SpeechSettingsInput;
  const scenario = source.scenario ?? fallbackScenario;
  assertScenario(scenario);
  const model = nullableModel(source.model, 'model') || SPEECH_PRESETS.balanced.model;
  const device = enumValue(source.device, 'cpu', DEVICES, 'device');
  const computeType = source.computeType == null || source.computeType === ''
    ? defaultComputeType(device)
    : enumValue(source.computeType, 'int8', COMPUTE_TYPES, 'computeType');

  return Object.freeze({
    scenario,
    model,
    language: enumValue(source.language ?? source.lang, 'ru', LANGUAGES, 'language'),
    device,
    computeType,
    beamSize: integerValue(source.beamSize, 5, { min: 1, max: 20, field: 'beamSize' }),
    hotwords: hotwordsValue(source.hotwords ?? source.dictionary),
    vadSilenceMs: integerValue(source.vadSilenceMs, 500, { min: 0, max: 10_000, field: 'vadSilenceMs' }),
    conditionOnPreviousText: booleanValue(
      source.conditionOnPreviousText,
      true,
      'conditionOnPreviousText',
    ),
    initialPrompt: initialPromptValue(source.initialPrompt, 'initialPrompt'),
  });
}
