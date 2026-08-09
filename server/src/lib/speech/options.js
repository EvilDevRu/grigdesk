import { isSpeechModelId } from './catalog.js';

export const SPEECH_PRESETS = Object.freeze({
  fast: Object.freeze({ model: 'small', beamSize: 1 }),
  balanced: Object.freeze({ model: 'medium', beamSize: 5 }),
  accurate: Object.freeze({ model: 'large-v3-turbo', beamSize: 5 }),
});

export const SPEECH_SCENARIOS = Object.freeze(['dictation', 'video']);

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

function speechSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if (value.speech && typeof value.speech === 'object' && !Array.isArray(value.speech)) {
    return value.speech;
  }
  return value;
}

function enumValue(value, fallback, allowed, field) {
  const selected = value ?? fallback;
  if (typeof selected !== 'string' || !allowed.has(selected)) {
    throw new TypeError(`Некорректное значение speech.${field}: ${String(selected)}`);
  }
  return selected;
}

function nullableModel(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !isSpeechModelId(value)) {
    throw new TypeError(`Неизвестная модель в speech.${field}: ${String(value)}`);
  }
  return value;
}

function integerValue(value, fallback, { min, max, field }) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < min || selected > max) {
    throw new TypeError(`speech.${field} должен быть целым от ${min} до ${max}`);
  }
  return selected;
}

function booleanValue(value, fallback, field) {
  const selected = value ?? fallback;
  if (typeof selected !== 'boolean') {
    throw new TypeError(`speech.${field} должен быть boolean`);
  }
  return selected;
}

function hotwordsValue(value) {
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw new TypeError('speech.dictionary должен быть строкой');
  }
  return value.trim();
}

function assertScenario(scenario) {
  if (!SPEECH_SCENARIOS.includes(scenario)) {
    throw new TypeError(`Неизвестный сценарий речи: ${String(scenario)}`);
  }
}

function defaultComputeType(device) {
  if (device === 'cuda') return 'float16';
  if (device === 'auto') return 'auto';
  return 'int8';
}

/**
 * Разрешает настройки в полный набор параметров одного запуска.
 * Продвинутые model/beam/vad/condition относятся только к диктовке; для видео
 * существует отдельный videoModel, чтобы сценарии не переопределяли друг друга.
 */
export function resolveSpeechOptions(settings = {}, scenario = 'dictation') {
  assertScenario(scenario);
  const source = speechSettings(settings);
  const qualityField = scenario === 'video' ? 'videoQuality' : 'quality';
  const quality = enumValue(source[qualityField], 'balanced', new Set(Object.keys(SPEECH_PRESETS)), qualityField);
  const preset = SPEECH_PRESETS[quality];
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
  });
}

/**
 * Нормализует уже разрешённые options на transport-границе. В отличие от resolver,
 * здесь model относится именно к текущему запуску и не переинтерпретируется как
 * dictation/video override.
 */
export function normalizeSpeechOptions(options = {}, fallbackScenario = 'dictation') {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Параметры речи должны быть объектом');
  }
  const scenario = options.scenario ?? fallbackScenario;
  assertScenario(scenario);
  const model = nullableModel(options.model, 'model') || SPEECH_PRESETS.balanced.model;
  const device = enumValue(options.device, 'cpu', DEVICES, 'device');
  const computeType = options.computeType == null || options.computeType === ''
    ? defaultComputeType(device)
    : enumValue(options.computeType, 'int8', COMPUTE_TYPES, 'computeType');

  return Object.freeze({
    scenario,
    model,
    language: enumValue(options.language ?? options.lang, 'ru', LANGUAGES, 'language'),
    device,
    computeType,
    beamSize: integerValue(options.beamSize, 5, { min: 1, max: 20, field: 'beamSize' }),
    hotwords: hotwordsValue(options.hotwords ?? options.dictionary),
    vadSilenceMs: integerValue(options.vadSilenceMs, 500, { min: 0, max: 10_000, field: 'vadSilenceMs' }),
    conditionOnPreviousText: booleanValue(
      options.conditionOnPreviousText,
      true,
      'conditionOnPreviousText',
    ),
  });
}
