// Артефакты ролика и их зависимости.
//
// Свежесть здесь ВЫЧИСЛЯЕТСЯ, а не отмечается флагом. Ручной `stale` разошёлся бы
// с правдой при первой же правке, которую забыли им пометить, поэтому у каждого
// артефакта есть хеш входов: изменились входы — артефакт устарел, совпали —
// переделывать нечего, сколько бы правок ни было в соседней сцене.
//
// Артефакты неизменяемы. Задание получает снимок входов и, закончив, сравнивает
// их с текущими: если ролик за это время изменился, результат остаётся файлом на
// диске, но актуальной ссылкой не становится.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type {
  ShowcaseArtifactRef,
  ShowcaseProject,
  ShowcaseScene,
} from '../../../../shared/showcaseContracts.ts';
import { ShowcaseError } from './errors.ts';

/**
 * Версии инструментов входят в хеш наравне с данными сцены: другая версия браузера
 * или сборщика даёт другую картинку из тех же действий, и считать такой клип
 * свежим нельзя.
 */
export interface ProducerVersions {
  recorder: string;
  voice: string;
  assembler: string;
}

export interface RenderStyle {
  width: number;
  height: number;
  fps: number;
  theme: string;
  locale: string;
  burnSubtitles: boolean;
}

export interface ArtifactInputs {
  targetFingerprint: string;
  policyRevision: string;
  dataRevision: string;
  style: RenderStyle;
  versions: ProducerVersions;
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

/**
 * Звук сцены зависит от произносимого текста, указаний и выбранного голоса — и
 * НЕ зависит от действий на экране. Загруженная запись зависит только от самого
 * файла: переозвучивать её нельзя, поэтому текст в её хеш не входит.
 */
export function audioInputHash(scene: ShowcaseScene, inputs: ArtifactInputs): string {
  // У загруженной записи вход — она сама. Поэтому её хеш входов равен хешу
  // содержимого: правка текста такую сцену не старит (переозвучивать импорт
  // нельзя), а подмена файла — старит сразу.
  if (scene.audioSource.kind === 'recorded') {
    return scene.audio?.contentHash ?? '';
  }

  return hashOf({
    kind: 'tts',
    narration: scene.narration,
    direction: scene.direction,
    voiceRef: scene.audioSource.voiceRef,
    version: inputs.versions.voice,
  });
}

/**
 * Клип зависит от экрана, начального состояния и действий, а также от всего, что
 * меняет саму картинку: размеров, темы, версии браузера и состояния цели. Текст
 * речи в него не входит — правка фразы не заставляет переписывать экран.
 */
export function clipInputHash(scene: ShowcaseScene, inputs: ArtifactInputs): string {
  return hashOf({
    screenId: scene.screenId,
    startState: scene.startState,
    readyCondition: scene.readyCondition,
    actions: scene.actions,
    style: inputs.style,
    target: inputs.targetFingerprint,
    policy: inputs.policyRevision,
    data: inputs.dataRevision,
    version: inputs.versions.recorder,
  });
}

/**
 * Кадр снимается из той же записи, что и клип, поэтому делит с ним входы. Отдельный
 * прогон ради кадров не нужен — и в режиме с мутациями он был бы прямо вреден.
 */
export function frameInputHash(scene: ShowcaseScene, inputs: ArtifactInputs): string {
  return clipInputHash(scene, inputs);
}

/**
 * Итог зависит от содержимого сцен, их ПОРЯДКА и оформления. Содержимое берётся
 * хешами готовых артефактов: пересобирать ролик нужно тогда, когда изменилось то,
 * из чего он склеен, а не всякий раз, когда в сцене поправили заголовок.
 */
export function finalInputHash(project: ShowcaseProject, inputs: ArtifactInputs): string {
  const scenes = [...project.scenes]
    .sort((left, right) => left.order - right.order)
    .map((scene) => ({
      id: scene.id,
      order: scene.order,
      audio: scene.audio?.contentHash ?? null,
      clip: scene.clip?.contentHash ?? null,
      subtitleText: scene.subtitleText,
      caption: scene.caption,
      timing: scene.timing,
    }));

  return hashOf({
    scenes,
    style: inputs.style,
    version: inputs.versions.assembler,
  });
}

export interface SceneFreshness {
  audio: boolean;
  clip: boolean;
  frame: boolean;
  stale: boolean;
}

/**
 * Свежесть сцены: артефакт свеж, если он есть и его хеш входов совпадает с текущим.
 * Отсутствие артефакта — это «ещё не сделано», а не «устарело», но для кнопки
 * сборки разница невелика: и то и другое требует работы.
 */
export function sceneFreshness(scene: ShowcaseScene, inputs: ArtifactInputs): SceneFreshness {
  const audio = scene.audio !== null && scene.audio.inputHash === audioInputHash(scene, inputs);
  const clip = scene.clip !== null && scene.clip.inputHash === clipInputHash(scene, inputs);
  const frame = scene.frame !== null && scene.frame.inputHash === frameInputHash(scene, inputs);

  return {
    audio,
    clip,
    frame,
    stale: !audio || !clip,
  };
}

/**
 * Актуален ли собранный ролик. Двух условий мало по отдельности, поэтому проверяются
 * оба.
 *
 * Первое — хеш итога: перестановка сцен не портит их артефакты, но меняет порядок и
 * абсолютные таймкоды субтитров.
 *
 * Второе — свежесть каждой сцены. Итог склеен из ФАЙЛОВ, и правка текста их не
 * меняет: пока сцену не переозвучили, содержимое ролика прежнее, а хеш итога — тот
 * же. Без этой проверки ролик со старой речью считался бы актуальным для нового
 * текста, и человек отправил бы его как готовый.
 */
export function finalIsCurrent(project: ShowcaseProject, inputs: ArtifactInputs): boolean {
  if (!project.latestFinal) {
    return false;
  }

  if (project.latestFinal.video.inputHash !== finalInputHash(project, inputs)) {
    return false;
  }

  return project.scenes.every((scene) => !sceneFreshness(scene, inputs).stale);
}

export interface PublishInput {
  file: string;
  kind: ShowcaseArtifactRef['kind'];
  inputHash: string;
  producerVersion: string;
  durationMs?: number | null;
  targetDir: string;
}

/**
 * Публикация артефакта: файл переносится в хранилище под своим идентификатором,
 * и только после этого о нём узнаёт запись ролика. Хеш содержимого считает сервер
 * по готовому файлу — доверять размеру и имени, пришедшим от исполнителя, нельзя.
 */
export async function publishArtifact(input: PublishInput): Promise<ShowcaseArtifactRef> {
  const info = await fs.stat(input.file).catch(() => null);

  if (!info || !info.isFile() || info.size === 0) {
    throw new ShowcaseError(
      'artifact_missing',
      'Исполнитель не оставил файла результата.',
      500,
    );
  }

  const contentHash = await hashFile(input.file);
  const id = `${input.kind}-${randomBytes(6).toString('hex')}`;
  const extension = path.extname(input.file) || '.bin';
  const target = path.join(input.targetDir, `${id}${extension}`);

  await fs.mkdir(input.targetDir, { recursive: true, mode: 0o700 });
  await fs.rename(input.file, target);
  await fs.chmod(target, 0o600).catch(() => null);

  return {
    id,
    kind: input.kind,
    inputHash: input.inputHash,
    contentHash,
    producerVersion: input.producerVersion,
    durationMs: input.durationMs ?? null,
    byteSize: info.size,
  };
}

/** Хеш содержимого читается потоком: итоговый ролик бывает в сотни мегабайт. */
export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');

  try {
    const stream = handle.createReadStream();

    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
  } finally {
    await handle.close();
  }

  return hash.digest('hex').slice(0, 32);
}

/**
 * Путь артефакта по его идентификатору. Идентификатор проверяется по форме, а не
 * подставляется в путь как есть: имя из запроса не должно уметь выйти за каталог
 * ролика ни через `..`, ни через слэш.
 */
export function artifactFile(
  dir: string,
  id: string,
  extension: string,
): string {
  if (!/^(audio|clip|frame|final|subtitles)-[a-f0-9]{12}$/.test(id)) {
    throw new ShowcaseError('bad_artifact', 'Идентификатор артефакта имеет недопустимую форму.', 400);
  }

  return path.join(dir, `${id}${extension}`);
}

const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.srt': 'application/x-subrip; charset=utf-8',
};

/**
 * Тип содержимого выбирается по расширению из закрытого списка. Угадывать его по
 * первым байтам файла здесь незачем: файлы кладёт сам раздел, а неизвестное
 * расширение означает ошибку публикации, а не новый формат.
 */
export function mediaTypeOf(file: string): string {
  const type = MEDIA_TYPES[path.extname(file).toLowerCase()];

  if (!type) {
    throw new ShowcaseError('bad_artifact', 'Неизвестный тип артефакта.', 400);
  }

  return type;
}
