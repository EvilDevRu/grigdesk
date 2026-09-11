// Модели Silero, которые раздел умеет поставить сам.
//
// Это allowlist с закреплёнными адресом, размером и sha256: модель — исполняемый
// torch-пакет, и «принесите с чужого сервера что угодно и запустите» кнопкой
// быть не должно. Хеши сняты с файла, скачанного при добавлении записи.
//
// Одна модель несёт несколько дикторов сразу, поэтому пакет объявляет их списком:
// человеку выбирать голос ушами, а не гадать по идентификатору.

export interface SileroSpeaker {
  id: string;
  name: string;
  timbre: string;
}

export interface SileroVoicePackage {
  engineId: 'silero';
  id: string;
  name: string;
  language: string;
  timbre: string;
  url: string;
  fileName: string;
  fileSha256: string;
  fileBytes: number;
  // Скачивание движка (torch для процессора) весит на порядок больше модели —
  // человек должен видеть это число ДО нажатия.
  engineBytes: number;
  sampleRate: number;
  license: string;
  speakers: readonly SileroSpeaker[];
}

// Закреплена самая свежая модель автора (v5.5, апрель 2026): она сама ставит
// ударения, различает омографы и интонацию вопроса. Прежняя v4 звучала глуше —
// замер на одной фразе даёт ей на 3–4 дБ меньше энергии выше 8 кГц.
export const SILERO_VOICES: readonly SileroVoicePackage[] = Object.freeze([
  Object.freeze({
    engineId: 'silero' as const,
    id: 'v5_5_ru',
    name: 'Silero v5.5',
    language: 'ru',
    timbre: 'три женских и два мужских',
    url: 'https://models.silero.ai/models/tts/ru/v5_5_ru.pt',
    fileName: 'v5_5_ru.pt',
    fileSha256: '50081637b602126ee06cb3bc8a744d25651d2da149ee8864b9a379bfdd934437',
    fileBytes: 145_420_684,
    engineBytes: 200_000_000,
    sampleRate: 48_000,
    license: 'CC BY-NC-SA 4.0 (некоммерческое использование)',
    speakers: Object.freeze([
      Object.freeze({ id: 'xenia', name: 'Ксения', timbre: 'женский' }),
      Object.freeze({ id: 'baya', name: 'Бая', timbre: 'женский' }),
      Object.freeze({ id: 'kseniya', name: 'Ксюша', timbre: 'женский' }),
      Object.freeze({ id: 'aidar', name: 'Айдар', timbre: 'мужской' }),
      Object.freeze({ id: 'eugene', name: 'Евгений', timbre: 'мужской' }),
    ]),
  }),
]);

export function sileroVoicePackage(id: string): SileroVoicePackage | null {
  return SILERO_VOICES.find((item) => item.id === id) ?? null;
}
