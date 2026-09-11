// Голоса Yandex SpeechKit (API v3), русский язык.
//
// Список закреплён в коде, потому что у поставщика нет ручки «перечислить голоса»:
// адаптер объявляет то, что сверено с документацией поставщика 11.09.2026, а
// работу ключа подтверждает первый образец. Новые нейросетевые голоса (Даша, Лера,
// Маша, Юлия, Александр, Антон, Кирилл) есть только в API v3 — поэтому адаптер
// ходит именно в него, а не в устаревший v1.
//
// Амплуа (role) у каждого голоса свои. Тон переводится в амплуа только там, где
// оно объявлено: поставщик отвечает на чужое амплуа ошибкой, а не нейтральной речью.

export interface YandexVoice {
  id: string;
  name: string;
  timbre: 'женский' | 'мужской';
  roles: string[];
}

export const YANDEX_TTS_ENDPOINT = 'https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis';

// Голос поставщика по умолчанию: им же адаптер отвечает на ссылку без голоса.
export const YANDEX_DEFAULT_VOICE: YandexVoice = {
  id: 'marina',
  name: 'Марина',
  timbre: 'женский',
  roles: ['neutral', 'whisper', 'friendly'],
};

// Порядок — порядок показа: первым идёт голос по умолчанию, за ним новые
// нейросетевые голоса, затем прежние.
export const YANDEX_VOICES: YandexVoice[] = [
  YANDEX_DEFAULT_VOICE,
  { id: 'dasha', name: 'Даша', timbre: 'женский', roles: ['neutral', 'good', 'friendly'] },
  { id: 'lera', name: 'Лера', timbre: 'женский', roles: ['neutral', 'friendly'] },
  { id: 'masha', name: 'Маша', timbre: 'женский', roles: ['good', 'strict', 'friendly'] },
  { id: 'julia', name: 'Юлия', timbre: 'женский', roles: ['neutral', 'strict'] },
  { id: 'jane', name: 'Джейн', timbre: 'женский', roles: ['neutral', 'good', 'evil'] },
  { id: 'omazh', name: 'Омаж', timbre: 'женский', roles: ['neutral', 'evil'] },
  { id: 'alexander', name: 'Александр', timbre: 'мужской', roles: ['neutral', 'good'] },
  { id: 'anton', name: 'Антон', timbre: 'мужской', roles: ['neutral', 'good'] },
  { id: 'kirill', name: 'Кирилл', timbre: 'мужской', roles: ['neutral', 'strict', 'good'] },
  { id: 'filipp', name: 'Филипп', timbre: 'мужской', roles: [] },
  { id: 'ermil', name: 'Ермил', timbre: 'мужской', roles: ['neutral', 'good'] },
  { id: 'zahar', name: 'Захар', timbre: 'мужской', roles: ['neutral', 'good'] },
  { id: 'madi_ru', name: 'Мади', timbre: 'мужской', roles: [] },
];

// Тон из нейтральных указаний ядра — в амплуа поставщика. Слова человека и
// английские идентификаторы принимаются одинаково: указание пишет и модель, и
// человек, а ядро тон не нормализует.
export const YANDEX_ROLE_BY_TONE: Record<string, string> = {
  neutral: 'neutral',
  нейтрально: 'neutral',
  нейтральный: 'neutral',
  спокойно: 'neutral',
  good: 'good',
  радостно: 'good',
  весело: 'good',
  бодро: 'good',
  friendly: 'friendly',
  дружелюбно: 'friendly',
  тепло: 'friendly',
  strict: 'strict',
  строго: 'strict',
  серьёзно: 'strict',
  серьезно: 'strict',
  whisper: 'whisper',
  шёпотом: 'whisper',
  шепотом: 'whisper',
  evil: 'evil',
  раздражённо: 'evil',
  раздраженно: 'evil',
};
