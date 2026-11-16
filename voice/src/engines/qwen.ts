import { combineSignals } from '../audioFile.ts';
import { unsupportedDirections, validateSynthesis, VoiceError } from '../contract.ts';
import type { VoiceCapabilities, VoiceEngine } from '../contract.ts';
import { QWEN_VOICES, qwenVoiceData } from './qwenVoices.ts';
import { requestQwenAudio } from './qwenTransport.ts';
import type { QwenConnection } from './qwenTransport.ts';

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  zh: 'Chinese',
  en: 'English',
  fr: 'French',
  de: 'German',
  ru: 'Russian',
  it: 'Italian',
  es: 'Spanish',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
};

const ENDPOINT = '/api/v1/services/aigc/multimodal-generation/generation';

/**
 * Профиль qwen3-tts-flash отделён от Qwen-Audio-TTS: у него другой endpoint и лимит.
 * Формат v1 только WAV; темп, разметка ударений и инструкция остаются в отчёте.
 */
export function createQwenEngine(options: QwenConnection): VoiceEngine {
  const own: VoiceCapabilities = {
    languages: Object.keys(LANGUAGE_NAMES),
    pace: false,
    stress: false,
    pause: false,
    tone: false,
    emphasis: false,
    maxChars: 600,
    formats: ['wav'],
  };

  const subscriptionKey = Boolean(options.apiKey?.startsWith('sk-sp-'));
  const ready = Boolean(options.apiKey) && !subscriptionKey;

  return {
    id: 'qwen',
    service: 'model-studio',
    name: 'Qwen (облако)',
    kind: 'cloud',
    model: 'qwen3-tts-flash',
    defaultVoice: 'Cherry',
    capabilities: () => own,
    doctor: async () => ({
      status: ready ? 'ready' : 'blocked',
      reason: subscriptionKey ? 'ключ подписки несовместим с model-studio'
        : ready ? 'ключ задан' : 'нет ключа',
      install: subscriptionKey ? 'для QwenCloud Token Plan укажите --service qwencloud-token'
        : ready ? '' : 'задайте GRIGDESK_VOICE_QWEN_API_KEY или DASHSCOPE_API_KEY',
    }),
    voices: async () => QWEN_VOICES.map((voice) => ({
      id: voice.id,
      name: voice.name,
      languages: [...voice.languages],
      available: ready,
      reason: ready ? '' : subscriptionKey ? 'нужен выбор подписочного сервиса' : 'нет ключа',
    })),
    /**
     * Один deadline охватывает POST, JSON, GET и чтение WAV; платный POST не повторяется.
     * Ни сырой ответ, ни исключение fetch не попадают наружу вместе с секретами сервиса.
     */
    async synthesize(input, synthesisOptions) {
      const external = combineSignals(options.signal, synthesisOptions.signal);
      const prepared = validateSynthesis(input, { ...synthesisOptions, signal: external }, own);
      const voice = input.voiceRef ?? 'Cherry';

      if (!qwenVoiceData(voice)) {
        throw new VoiceError('Неизвестный голос Qwen.', 2);
      }

      const language = input.language === null ? 'Auto' : LANGUAGE_NAMES[input.language];

      if (!language) {
        throw new VoiceError('Неизвестный язык Qwen.', 2);
      }

      if (!options.apiKey) {
        throw new VoiceError('Нет ключа Qwen.');
      }

      if (/[\r\n]/u.test(options.apiKey)) {
        throw new VoiceError('Ключ Qwen содержит недопустимые символы.');
      }

      if (subscriptionKey) {
        throw new VoiceError(
          'Ключ подписки не подходит model-studio; для Token Plan укажите --service qwencloud-token.',
        );
      }

      const result = await requestQwenAudio({
        ...options,
        signal: external,
        endpoint: ENDPOINT,
        body: {
          model: 'qwen3-tts-flash',
          input: {
            text: prepared.canonicalText,
            voice,
            language_type: language,
          },
        },
        outputFile: synthesisOptions.outputFile,
        timeoutMs: synthesisOptions.timeoutMs,
      });

      return {
        ...result,
        ignoredDirections: unsupportedDirections({
          pace: synthesisOptions.pace,
          stresses: prepared.stresses,
          instruction: synthesisOptions.instruction,
        }, own),
      };
    },
  };
}
