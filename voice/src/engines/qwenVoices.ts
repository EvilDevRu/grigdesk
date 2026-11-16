// Голоса облачного qwen3-tts-flash. Источник — официальный список Model Studio
// (qwen-tts-voice-list, обновление 2026-10-11): параметры голосов и их языки.
// У стандартных голосов одни и те же десять языков, включая русский; диалектные
// отличаются первым языком. Список — данные, ядро по нему не ветвится.

const LANGS_TEN = Object.freeze([
  'zh', 'en', 'fr', 'de', 'ru', 'it', 'es', 'pt', 'ja', 'ko',
]);

export interface QwenVoiceData {
  id: string;
  name: string;
  gender: 'женский' | 'мужской';
  languages: readonly string[];
  note: string;
}

interface Raw {
  id: string;
  name: string;
  gender: 'женский' | 'мужской';
  note: string;
}

const STANDARD: readonly Raw[] = Object.freeze([
  {
    id: 'Cherry',
    name: 'Cherry',
    gender: 'женский',
    note: 'солнечная, дружелюбная',
  },
  {
    id: 'Serena',
    name: 'Serena',
    gender: 'женский',
    note: 'мягкая',
  },
  {
    id: 'Ethan',
    name: 'Ethan',
    gender: 'мужской',
    note: 'тёплый, энергичный',
  },
  {
    id: 'Chelsie',
    name: 'Chelsie',
    gender: 'женский',
    note: 'двумерная подружка',
  },
  {
    id: 'Momo',
    name: 'Momo',
    gender: 'женский',
    note: 'игривая',
  },
  {
    id: 'Vivian',
    name: 'Vivian',
    gender: 'женский',
    note: 'уверенная, задорная',
  },
  {
    id: 'Moon',
    name: 'Moon',
    gender: 'мужской',
    note: 'смелый Юэбай',
  },
  {
    id: 'Maia',
    name: 'Maia',
    gender: 'женский',
    note: 'умная и нежная',
  },
  {
    id: 'Kai',
    name: 'Kai',
    gender: 'мужской',
    note: 'успокаивающий',
  },
  {
    id: 'Nofish',
    name: 'Nofish',
    gender: 'мужской',
    note: 'дизайнер',
  },
  {
    id: 'Bella',
    name: 'Bella',
    gender: 'женский',
    note: 'пузырьчатая',
  },
  {
    id: 'Jennifer',
    name: 'Jennifer',
    gender: 'женский',
    note: 'кинематографический английский',
  },
  {
    id: 'Ryan',
    name: 'Ryan',
    gender: 'мужской',
    note: 'драматичный',
  },
  {
    id: 'Katerina',
    name: 'Katerina',
    gender: 'женский',
    note: 'зрелая, запоминающаяся',
  },
  {
    id: 'Aiden',
    name: 'Aiden',
    gender: 'мужской',
    note: 'молодой американец',
  },
  {
    id: 'Eldric Sage',
    name: 'Eldric Sage',
    gender: 'мужской',
    note: 'спокойный мудрец',
  },
  {
    id: 'Mia',
    name: 'Mia',
    gender: 'женский',
    note: 'нежная',
  },
  {
    id: 'Mochi',
    name: 'Mochi',
    gender: 'мужской',
    note: 'наивный умница',
  },
  {
    id: 'Bellona',
    name: 'Bellona',
    gender: 'женский',
    note: 'мощная, героическая',
  },
  {
    id: 'Vincent',
    name: 'Vincent',
    gender: 'мужской',
    note: 'хриплый, дымный',
  },
  {
    id: 'Bunny',
    name: 'Bunny',
    gender: 'женский',
    note: 'милый ребёнок',
  },
  {
    id: 'Neil',
    name: 'Neil',
    gender: 'мужской',
    note: 'диктор новостей',
  },
  {
    id: 'Elias',
    name: 'Elias',
    gender: 'женский',
    note: 'рассказчик-учитель',
  },
  {
    id: 'Arthur',
    name: 'Arthur',
    gender: 'мужской',
    note: 'земный, деревенский',
  },
  {
    id: 'Nini',
    name: 'Nini',
    gender: 'женский',
    note: 'ласковая',
  },
  {
    id: 'Seren',
    name: 'Seren',
    gender: 'женский',
    note: 'колыбельная',
  },
  {
    id: 'Pip',
    name: 'Pip',
    gender: 'мужской',
    note: 'озорной мальчишка',
  },
  {
    id: 'Stella',
    name: 'Stella',
    gender: 'женский',
    note: 'девочка-волшебница',
  },
  {
    id: 'Bodega',
    name: 'Bodega',
    gender: 'мужской',
    note: 'испанец',
  },
  {
    id: 'Sonrisa',
    name: 'Sonrisa',
    gender: 'женский',
    note: 'латиноамериканка',
  },
  {
    id: 'Alek',
    name: 'Alek',
    gender: 'мужской',
    note: 'русский дух',
  },
  {
    id: 'Dolce',
    name: 'Dolce',
    gender: 'мужской',
    note: 'итальянец',
  },
  {
    id: 'Sohee',
    name: 'Sohee',
    gender: 'женский',
    note: 'корейская унни',
  },
  {
    id: 'Ono Anna',
    name: 'Ono Anna',
    gender: 'женский',
    note: 'девичья подруга',
  },
  {
    id: 'Lenn',
    name: 'Lenn',
    gender: 'мужской',
    note: 'немец-бунтарь',
  },
  {
    id: 'Emilien',
    name: 'Emilien',
    gender: 'мужской',
    note: 'французский брат',
  },
  {
    id: 'Andre',
    name: 'Andre',
    gender: 'мужской',
    note: 'магнетичный, ровный',
  },
  {
    id: 'Radio Gol',
    name: 'Radio Gol',
    gender: 'мужской',
    note: 'футбольный комментатор',
  },
]);

const DIALECT: readonly (Raw & { language: string })[] = Object.freeze([
  {
    id: 'Jada',
    name: 'Shanghai - Jada',
    gender: 'женский',
    note: 'шанхайская тётушка',
    language: 'zh-shanghainese',
  },
  {
    id: 'Dylan',
    name: 'Beijing - Dylan',
    gender: 'мужской',
    note: 'пекинский парень',
    language: 'zh-beijing',
  },
  {
    id: 'Li',
    name: 'Nanjing - Li',
    gender: 'мужской',
    note: 'учитель йоги',
    language: 'zh-nanjing',
  },
  {
    id: 'Marcus',
    name: 'Shaanxi - Marcus',
    gender: 'мужской',
    note: 'шэньсийский север',
    language: 'zh-shaanxi',
  },
  {
    id: 'Roy',
    name: 'Southern Min - Roy',
    gender: 'мужской',
    note: 'тайваньский парень',
    language: 'zh-min-nan',
  },
  {
    id: 'Peter',
    name: 'Tianjin - Peter',
    gender: 'мужской',
    note: 'тяньцзиньский юмор',
    language: 'zh-tianjin',
  },
  {
    id: 'Sunny',
    name: 'Sichuan - Sunny',
    gender: 'женский',
    note: 'сычуаньская девочка',
    language: 'zh-sichuan',
  },
  {
    id: 'Eric',
    name: 'Sichuan - Eric',
    gender: 'мужской',
    note: 'чэндуский парень',
    language: 'zh-sichuan',
  },
  {
    id: 'Rocky',
    name: 'Cantonese - Rocky',
    gender: 'мужской',
    note: 'гонконгский юмор',
    language: 'zh-cantonese',
  },
  {
    id: 'Kiki',
    name: 'Cantonese - Kiki',
    gender: 'женский',
    note: 'гонконгская подруга',
    language: 'zh-cantonese',
  },
]);

export const QWEN_VOICES: readonly QwenVoiceData[] = Object.freeze([
  ...STANDARD.map((raw) => ({
    id: raw.id,
    name: raw.name,
    gender: raw.gender,
    languages: LANGS_TEN,
    note: raw.note,
  })),
  ...DIALECT.map((raw) => ({
    id: raw.id,
    name: raw.name,
    gender: raw.gender,
    languages: Object.freeze([raw.language, ...LANGS_TEN.slice(1)]),
    note: raw.note,
  })),
]);

/**
 * Голос по идентификатору или null: движок не выдумывает голоса сверх каталога.
 * Поиск не зависит от ключа и не вызывает сеть при проверке аргументов.
 */
export function qwenVoiceData(id: string): QwenVoiceData | null {
  return QWEN_VOICES.find((voice) => voice.id === id) ?? null;
}
