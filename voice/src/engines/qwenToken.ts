import { narrationLanguage } from '../../../shared/plugins/showcase/showcaseNarration.ts';

import { combineSignals } from '../audioFile.ts';
import { validateSynthesis, VoiceError } from '../contract.ts';
import type { VoiceCapabilities, VoiceEngine, VoicePace } from '../contract.ts';
import { qwenTokenInstruction, qwenTokenText } from './qwenTokenText.ts';
import { normalizeQwenTokenWav } from './qwenTokenWav.ts';
import { requestQwenAudio } from './qwenTransport.ts';
import type { QwenConnection } from './qwenTransport.ts';
import {
  TOKEN_DEFAULT_VOICE, TOKEN_TTS_MODEL, TOKEN_VOICES, TOKEN_VOICES_BY_ID,
} from './qwenTokenVoices.ts';

const RATE: Record<VoicePace, number> = {
  slowest: 0.7,
  slow: 0.85,
  normal: 1,
  fast: 1.15,
  fastest: 1.3,
};

/**
 * Token Plan выбирается явно и использует свой API, модель и каталог голосов.
 * Ударения передаются как экспериментальные указания, без обещания точного произношения.
 */
export function createQwenTokenEngine(options: QwenConnection): VoiceEngine {
  const own: VoiceCapabilities = {
    languages: ['ru', 'en', 'zh'],
    pace: true,
    stress: true,
    stressMode: 'experimental',
    instruction: true,
    pause: false,
    tone: false,
    emphasis: false,
    maxChars: 2000,
    formats: ['wav'],
  };
  const ready = Boolean(options.apiKey?.startsWith('sk-sp-'));

  return {
    id: 'qwen',
    name: 'QwenCloud Token Plan (облако)',
    service: 'qwencloud-token',
    kind: 'cloud',
    model: TOKEN_TTS_MODEL,
    defaultVoice: TOKEN_DEFAULT_VOICE,
    capabilities: () => own,
    doctor: async () => ({
      status: ready ? 'ready' : 'blocked',
      reason: ready ? 'подписочный ключ задан; доступ подтверждает живой запрос'
        : 'нет ключа QwenCloud Token Plan формата sk-sp-…',
      install: ready ? '' : 'задайте TOKEN_PLAN_API_KEY или GRIGDESK_VOICE_QWEN_API_KEY',
    }),
    voices: async () => TOKEN_VOICES.map((voice) => ({
      ...voice,
      available: ready,
      reason: ready ? '' : 'нет подписочного ключа',
    })),
    /**
     * Валидация голоса, языка и инструкции завершается до HTTP и создания выходных файлов.
     * Выбранный сервис не заменяется другим после отказа, а PCM публикуется только после проверки WAV.
     */
    async synthesize(input, synthesisOptions) {
      const signal = combineSignals(options.signal, synthesisOptions.signal);
      const prepared = validateSynthesis(input, { ...synthesisOptions, signal }, own);
      const voice = TOKEN_VOICES_BY_ID.get(input.voiceRef ?? TOKEN_DEFAULT_VOICE);

      if (!voice) {
        throw new VoiceError(
          'Неизвестный голос Qwen Token Plan. Посмотрите список командой voice voices.',
          2,
        );
      }

      const suggested = narrationLanguage(prepared.canonicalText);
      const language = input.language
        ?? (suggested && voice.languages.includes(suggested) ? suggested : voice.languages[0]);

      if (!voice.languages.includes(language)) {
        throw new VoiceError(`Голос «${voice.name}» поддерживает языки: ${voice.languages.join(', ')}.`, 2);
      }

      const text = qwenTokenText(prepared);
      const instruction = qwenTokenInstruction(text, language, synthesisOptions.instruction);

      if (!ready) {
        throw new VoiceError('Для qwencloud-token нужен подписочный ключ sk-sp-….');
      }

      const result = await requestQwenAudio({
        ...options,
        signal,
        endpoint: '/api/v1/services/audio/tts/SpeechSynthesizer',
        body: {
          model: TOKEN_TTS_MODEL,
          input: {
            text,
            voice: voice.id,
            format: 'wav',
            sample_rate: 24000,
            language_hints: [language],
            rate: RATE[synthesisOptions.pace ?? 'normal'],
            instruction,
          },
        },
        outputFile: synthesisOptions.outputFile,
        timeoutMs: synthesisOptions.timeoutMs,
        prepareFile: normalizeQwenTokenWav,
      });

      return {
        ...result,
        ignoredDirections: [],
        warnings: text.includes('\u0301')
          ? ['Ударения Qwen экспериментальны: проверьте произношение по аудио.'] : [],
      };
    },
  };
}
