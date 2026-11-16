// Значения сверены с server/src/lib/showcase/voice/piperCatalog.ts и sileroCatalog.ts.
// Зависимости — requirements-showcase-voice.txt и requirements-showcase-silero.txt.
// Дублирование временное: standalone SEA не импортирует серверный код showcase.

interface PackageBase {
  id: string;
  name: string;
  language: string;
  timbre: string;
  url: string;
  sampleRate: number;
  license: string;
  requirements: readonly string[];
  requirementsIndexUrl: string | null;
}

export interface PiperPackage extends PackageBase {
  engineId: 'piper';
  archiveSha256: string;
  archiveBytes: number;
  modelName: string;
  modelSha256: string;
  configName: string;
  configSha256: string;
}

export interface SileroSpeaker {
  id: string;
  name: string;
  timbre: string;
}

export interface SileroPackage extends PackageBase {
  engineId: 'silero';
  fileName: string;
  fileSha256: string;
  fileBytes: number;
  engineBytes: number;
  speakers: readonly SileroSpeaker[];
}

export type LocalPackage = PiperPackage | SileroPackage;

export const PIPER_PACKAGE: PiperPackage = Object.freeze({
  engineId: 'piper',
  id: 'irina',
  name: 'Ирина',
  language: 'ru',
  timbre: 'женский',
  url: 'https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-ru-irinia-medium.tar.gz',
  archiveSha256: '897b62f170faee38f21d0bc36411164166ae351977e898b6cf33f6206890b55f',
  archiveBytes: 58_340_190,
  modelName: 'ru-irinia-medium.onnx',
  modelSha256: '8ff38212d23da300bbe3705c645e6e5b9475f0bfde01558eb17813e22acaaaaa',
  configName: 'ru-irinia-medium.onnx.json',
  configSha256: '2cb86fe3fb3b5af5215c07d8d13a9026ac19f26da86098abb843260469d6e3dd',
  sampleRate: 22_050,
  license: 'GPLv2 (обучен на корпусе RHVoice)',
  requirements: Object.freeze(['piper-tts==1.8.0', 'onnxruntime==1.23.2']),
  requirementsIndexUrl: null,
});

export const SILERO_PACKAGE: SileroPackage = Object.freeze({
  engineId: 'silero',
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
  requirements: Object.freeze(['torch==2.13.0+cpu']),
  requirementsIndexUrl: 'https://download.pytorch.org/whl/cpu',
  speakers: Object.freeze([
    Object.freeze({
      id: 'xenia',
      name: 'Ксения',
      timbre: 'женский',
    }),
    Object.freeze({
      id: 'baya',
      name: 'Бая',
      timbre: 'женский',
    }),
    Object.freeze({
      id: 'kseniya',
      name: 'Ксюша',
      timbre: 'женский',
    }),
    Object.freeze({
      id: 'aidar',
      name: 'Айдар',
      timbre: 'мужской',
    }),
    Object.freeze({
      id: 'eugene',
      name: 'Евгений',
      timbre: 'мужской',
    }),
  ]),
});

export const LOCAL_PACKAGES: readonly LocalPackage[] = Object.freeze([
  PIPER_PACKAGE,
  SILERO_PACKAGE,
]);

/**
 * Выбирает один закреплённый пакет движка без обращения к сети или серверу.
 * Альтернативный набор передаётся только вызывающим кодом, например фикстурой теста.
 */
export function localPackage(
  engineId: string,
  packages: readonly LocalPackage[] = LOCAL_PACKAGES,
): LocalPackage | null {
  return packages.find((item) => item.engineId === engineId) ?? null;
}
