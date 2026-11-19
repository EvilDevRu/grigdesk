import baseVoices from './qwenTokenBaseVoices.json' with { type: 'json' };

export const TOKEN_TTS_MODEL = 'qwen-audio-3.0-tts-plus';
export const TOKEN_DEFAULT_VOICE = 'longanhuan_v3.6';

const MANDARIN_ENGLISH = ['zh', 'en'] as const;

interface TokenVoice {
  id: string;
  name: string;
  languages: readonly [string, ...string[]];
}

// Системные голоса и таблица базовых голосов этой модели опубликованы QwenCloud.
// Long An Huan приведён в примере Token Plan и экспериментально озвучивал русский.
// https://docs.qwencloud.com/developer-guides/speech/voice-list/qwen-audio-tts
export const TOKEN_VOICES: readonly TokenVoice[] = [
  {
    id: TOKEN_DEFAULT_VOICE,
    name: 'Long An Huan',
    languages: ['ru', 'en', 'zh'],
  },
  {
    id: 'longanlingxin',
    name: 'Long An Ling Xin',
    languages: MANDARIN_ENGLISH,
  },
  {
    id: 'longanlufeng',
    name: 'Long An Lu Feng',
    languages: MANDARIN_ENGLISH,
  },
  ...Object.entries(baseVoices).flatMap(([language, voices]) => (
    Object.entries(voices).map(([suffix, name]) => ({
      id: `${TOKEN_TTS_MODEL}-${suffix}`,
      name,
      languages: [language] as const,
    }))
  )),
];

export const TOKEN_VOICES_BY_ID = new Map(TOKEN_VOICES.map((voice) => [voice.id, voice]));
