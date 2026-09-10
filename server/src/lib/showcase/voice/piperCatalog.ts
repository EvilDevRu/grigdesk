// Список голосов, которые раздел умеет поставить сам.
//
// Это allowlist, а не «что нашлось в сети»: у каждого голоса закреплены адрес,
// точный размер и sha256 архива и обоих распакованных файлов. Скачанное сверяется
// с этими числами до первого синтеза — иначе кнопка установки означала бы
// «принесите с чужого сервера что угодно и запустите».
//
// Голос всего один, и это следствие измеренной обстановки, а не выбора: русские
// голоса Piper лежат на huggingface.co, который с этой машины не открывается
// (TLS обрывается), а в релизах самого проекта опубликован ровно один русский
// голос. Появится доступ — в список добавятся остальные, с такими же хешами.

export interface PiperVoicePackage {
  id: string;
  name: string;
  language: string;
  // Женский/мужской: человек выбирает голос ушами, но подпись экономит ему
  // прослушивание всего списка.
  timbre: string;
  url: string;
  archiveSha256: string;
  archiveBytes: number;
  modelName: string;
  modelSha256: string;
  configName: string;
  configSha256: string;
  sampleRate: number;
  license: string;
}

export const PIPER_VOICES: readonly PiperVoicePackage[] = Object.freeze([
  Object.freeze({
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
  }),
]);

export function piperVoicePackage(id: string): PiperVoicePackage | null {
  return PIPER_VOICES.find((item) => item.id === id) ?? null;
}
