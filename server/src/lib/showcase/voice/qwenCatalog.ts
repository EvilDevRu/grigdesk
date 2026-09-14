// Модель Qwen3-TTS, которую раздел умеет поставить сам.
//
// Это allowlist с закреплённой ревизией репозитория и суммой каждого файла: модель —
// исполняемые веса, и «принесите с чужого сервера что угодно и запустите» кнопкой
// быть не должно. Файлы LFS сверяются по sha256, остальные — по git blob sha1
// (другой суммы у них в репозитории нет). Суммы сняты через API Hugging Face
// двумя независимыми запросами с одинаковым результатом.
//
// Отдельный репозиторий речевого токенизатора не нужен: тот же файл лежит в
// подкаталоге `speech_tokenizer/` самой модели.

export interface QwenSpeaker {
  id: string;
  name: string;
  timbre: string;
}

export interface QwenModelFile {
  // Путь относительно каталога модели; подкаталоги создаются при раскладке.
  path: string;
  bytes: number;
  sha256?: string;
  gitBlobSha1?: string;
}

export interface QwenVoicePackage {
  engineId: 'qwen';
  id: string;
  name: string;
  language: string;
  timbre: string;
  repository: string;
  revision: string;
  // Адрес файла: `${baseUrl}${file.path}`. LFS-файлы редиректят на CDN, поэтому
  // загрузка идёт с `redirect: 'follow'`.
  baseUrl: string;
  // Запасные адреса той же раскладки на случай, когда основной хост недоступен
  // (huggingface.co на некоторых маршрутах рвётся на TLS). Зеркалу не доверяют:
  // каждый файл сверяется с закреплённой суммой, откуда бы он ни пришёл.
  mirrorUrls?: readonly string[];
  files: readonly QwenModelFile[];
  modelBytes: number;
  // Движок (torch с CUDA и transformers) весит примерно столько же, сколько модель, —
  // человек должен видеть это число ДО нажатия.
  engineBytes: number;
  sampleRate: number;
  license: string;
  speakers: readonly QwenSpeaker[];
}

const REPOSITORY = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice';
const REVISION = '0c0e3051f131929182e2c023b9537f8b1c68adfe';

const FILES: readonly QwenModelFile[] = Object.freeze([
  Object.freeze({
    path: 'config.json',
    bytes: 4908,
    gitBlobSha1: '95d74b20b7485f5dfa09d05988d6c606ec226811',
  }),
  Object.freeze({
    path: 'generation_config.json',
    bytes: 245,
    gitBlobSha1: '1872b16d4535564abf2db5d6debe6cddd82b7f2e',
  }),
  Object.freeze({
    path: 'merges.txt',
    bytes: 1_671_839,
    gitBlobSha1: '20024bfe7c83998e9aeaf98a0cd6a2ce6306c2f0',
  }),
  Object.freeze({
    path: 'model.safetensors',
    bytes: 3_833_402_552,
    sha256: '38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137',
  }),
  Object.freeze({
    path: 'preprocessor_config.json',
    bytes: 127,
    gitBlobSha1: '0525dd953bb9241912f7147666f0d535165d5d4f',
  }),
  Object.freeze({
    path: 'speech_tokenizer/config.json',
    bytes: 2336,
    gitBlobSha1: '06cc8dc4c5ec8a1929086b71b98c313020d9268b',
  }),
  Object.freeze({
    path: 'speech_tokenizer/configuration.json',
    bytes: 76,
    gitBlobSha1: 'ab58e2eaf53cd14a1a2a7527d9261ceea93a24cd',
  }),
  Object.freeze({
    path: 'speech_tokenizer/model.safetensors',
    bytes: 682_293_092,
    sha256: '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258',
  }),
  Object.freeze({
    path: 'speech_tokenizer/preprocessor_config.json',
    bytes: 234,
    gitBlobSha1: 'ba40914f4f49ab98a8ca545d4892ef7291a39592',
  }),
  Object.freeze({
    path: 'tokenizer_config.json',
    bytes: 7344,
    gitBlobSha1: '6ff9fd60cc623bb54bbd603cbd418c97a11528d7',
  }),
  Object.freeze({
    path: 'vocab.json',
    bytes: 2_776_833,
    gitBlobSha1: '4783fe10ac3adce15ac8f358ef5462739852c569',
  }),
]);

// Дикторы CustomVoice. Родной язык каждого — не русский, поэтому акцент возможен
// и выбирать диктора надо ушами; первый в списке произносит контрольную фразу
// приёмки.
const SPEAKERS: readonly QwenSpeaker[] = Object.freeze([
  Object.freeze({ id: 'vivian', name: 'Вивиан', timbre: 'женский, родной китайский' }),
  Object.freeze({ id: 'serena', name: 'Серена', timbre: 'женский, родной китайский' }),
  Object.freeze({ id: 'ono_anna', name: 'Оно Анна', timbre: 'женский, родной японский' }),
  Object.freeze({ id: 'sohee', name: 'Сохи', timbre: 'женский, родной корейский' }),
  Object.freeze({ id: 'ryan', name: 'Райан', timbre: 'мужской, родной английский' }),
  Object.freeze({ id: 'aiden', name: 'Эйден', timbre: 'мужской, родной английский' }),
  Object.freeze({ id: 'uncle_fu', name: 'Дядя Фу', timbre: 'мужской, родной китайский' }),
  Object.freeze({ id: 'dylan', name: 'Дилан', timbre: 'мужской, пекинский говор' }),
  Object.freeze({ id: 'eric', name: 'Эрик', timbre: 'мужской, чэндуский говор' }),
]);

export const QWEN_VOICES: readonly QwenVoicePackage[] = Object.freeze([
  Object.freeze({
    engineId: 'qwen' as const,
    id: 'qwen3-tts-1_7b',
    name: 'Qwen3-TTS 1.7B',
    language: 'ru',
    timbre: 'четыре женских и пять мужских',
    repository: REPOSITORY,
    revision: REVISION,
    baseUrl: `https://huggingface.co/${REPOSITORY}/resolve/${REVISION}/`,
    mirrorUrls: Object.freeze([`https://hf-mirror.com/${REPOSITORY}/resolve/${REVISION}/`]),
    files: FILES,
    modelBytes: FILES.reduce((sum, file) => sum + file.bytes, 0),
    // Замер 11.09.2026: venv с torch 2.11 (CUDA) и transformers занял 5,4 ГБ.
    engineBytes: 5_400_000_000,
    sampleRate: 24_000,
    license: 'Apache-2.0',
    speakers: SPEAKERS,
  }),
]);

export function qwenVoicePackage(id: string): QwenVoicePackage | null {
  return QWEN_VOICES.find((item) => item.id === id) ?? null;
}
