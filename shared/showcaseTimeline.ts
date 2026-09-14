// Расписание сцены ролика. Формула общая для сервера и браузера: сборка режет
// ролик по ней, а экран ролика по ней же считает, с какой секунды начинается
// сцена, — иначе «смотреть сцену в ролике» вело бы не туда.
//
// Режим один — `voiceLeads`: сначала известна длительность звука, и только потом
// строится расписание. Обратный порядок заставлял бы резать речь под длину клипа,
// а показывать надо ровно то, что произносится. Конец сцены — максимум конца речи
// и конца действий плюс короткий хвост.
import { contractDecoders } from './contractDecoders.ts';
import { SHOWCASE_ID_RE } from './showcaseContracts.ts';
import type { ShowcaseScene, ShowcaseTiming } from './showcaseContracts.ts';
import { SHOWCASE_SYNC_CUE_KINDS } from './showcaseSync.ts';

export const PRE_ROLL_MS = 400;
export const POST_ROLL_MS = 600;

/** Версия публичного таймлайна готового MP4. */
export const SHOWCASE_MANIFEST_VERSION = 1 as const;

/**
 * Manifest не является идентификатором проекта. Суффикс — хеш точных JSON-байтов:
 * читатель проверяет содержимое без отдельной доверенной ссылки на sidecar.
 */
export const SHOWCASE_MANIFEST_ID_RE = /^manifest-[a-f0-9]{32}$/;

// Допуск только для разницы контейнерной длительности итогового MP4 и суммы уже
// измеренных сцен. Он покрывает один кадр 30 fps и округление AAC, но не уезд шкалы.
export const SHOWCASE_MANIFEST_MEDIA_TOLERANCE_MS = 50;

export class ShowcaseManifestContractError extends Error {
  constructor(path: string) {
    super(`Некорректный manifest ролика: поле ${path}`);
    this.name = 'ShowcaseManifestContractError';
  }
}

const {
  listOf,
  nullable,
  numeric,
  objectOf,
  oneOf,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new ShowcaseManifestContractError(path);
});

const manifestVideo = objectOf({
  id: text,
  contentHash: text,
  byteSize: wholeNumber,
  durationMs: numeric,
});

const manifestSubtitles = objectOf({
  id: text,
  contentHash: text,
  byteSize: wholeNumber,
});

const manifestPhrase = objectOf({
  id: text,
  text,
  startMs: numeric,
  endMs: numeric,
});

const manifestCue = objectOf({
  cueId: text,
  kind: oneOf(...SHOWCASE_SYNC_CUE_KINDS),
  actionIndex: wholeNumber,
  speechStartMs: numeric,
  speechEndMs: numeric,
  eventMs: numeric,
  errorMs: numeric,
});

const manifestScene = objectOf({
  id: text,
  order: wholeNumber,
  caption: text,
  startMs: numeric,
  endMs: numeric,
  durationMs: numeric,
  planHash: text,
  mode: oneOf('exact', 'legacy'),
  quality: oneOf('word-exact', 'phrase', 'approximate', 'missing'),
  phrases: listOf(manifestPhrase),
  cues: listOf(manifestCue),
});

const manifestSubtitleCue = objectOf({
  index: wholeNumber,
  sceneId: text,
  startMs: numeric,
  endMs: numeric,
  text,
});

const manifestDocument = objectOf({
  version: oneOf(SHOWCASE_MANIFEST_VERSION),
  projectId: text,
  inputHash: text,
  mode: oneOf('exact', 'legacy', 'mixed'),
  totalMs: numeric,
  video: manifestVideo,
  subtitles: nullable(manifestSubtitles),
  scenes: listOf(manifestScene),
  subtitleCues: listOf(manifestSubtitleCue),
});

export type ShowcaseManifestVideo = ReturnType<typeof manifestVideo>;
export type ShowcaseManifestSubtitles = ReturnType<typeof manifestSubtitles>;
export type ShowcaseManifestPhrase = ReturnType<typeof manifestPhrase>;
export type ShowcaseManifestCue = ReturnType<typeof manifestCue>;
export type ShowcaseManifestScene = ReturnType<typeof manifestScene>;
export type ShowcaseManifestSubtitleCue = ReturnType<typeof manifestSubtitleCue>;
export type ShowcaseFinalManifest = ReturnType<typeof manifestDocument>;

const HASH_RE = /^[a-f0-9]{32}$/;
const FINAL_ID_RE = /^final-[a-f0-9]{12}$/;
const SUBTITLES_ID_RE = /^subtitles-[a-f0-9]{12}$/;
const EPSILON_MS = 0.01;

function manifestFail(path: string): never {
  throw new ShowcaseManifestContractError(path);
}

function positiveInterval(startMs: number, endMs: number): boolean {
  return startMs >= 0 && endMs > startMs;
}

/**
 * Структурный codec дополнен проверкой самой шкалы. Иначе корректный по типам JSON
 * мог бы отправить плеер за пределы MP4 или дать SRT с переставленными сценами.
 */
export function parseShowcaseFinalManifest(value: unknown): ShowcaseFinalManifest {
  const manifest = manifestDocument(value, 'manifest');

  if (!SHOWCASE_ID_RE.test(manifest.projectId)) {
    manifestFail('manifest.projectId');
  }

  if (!HASH_RE.test(manifest.inputHash)) {
    manifestFail('manifest.inputHash');
  }

  if (
    !FINAL_ID_RE.test(manifest.video.id)
    || !HASH_RE.test(manifest.video.contentHash)
    || manifest.video.byteSize <= 0
    || manifest.video.durationMs <= 0
  ) {
    manifestFail('manifest.video');
  }

  if (manifest.subtitles && (
    !SUBTITLES_ID_RE.test(manifest.subtitles.id)
    || !HASH_RE.test(manifest.subtitles.contentHash)
    || manifest.subtitles.byteSize <= 0
  )) {
    manifestFail('manifest.subtitles');
  }

  if (manifest.scenes.length === 0 || manifest.totalMs <= 0) {
    manifestFail(manifest.scenes.length === 0 ? 'manifest.scenes' : 'manifest.totalMs');
  }

  const sceneIds = new Set<string>();
  let previousSceneEndMs = 0;

  for (const [sceneIndex, scene] of manifest.scenes.entries()) {
    const base = `manifest.scenes[${sceneIndex}]`;

    if (
      scene.id.trim() === ''
      || sceneIds.has(scene.id)
      || scene.order !== sceneIndex + 1
    ) {
      manifestFail(`${base}.id`);
    }

    if (
      !positiveInterval(scene.startMs, scene.endMs)
      || Math.abs(scene.startMs - previousSceneEndMs) > EPSILON_MS
      || Math.abs(scene.durationMs - (scene.endMs - scene.startMs)) > EPSILON_MS
      || !HASH_RE.test(scene.planHash)
    ) {
      manifestFail(`${base}.startMs`);
    }

    if (scene.mode === 'exact' && scene.quality !== 'word-exact') {
      manifestFail(`${base}.quality`);
    }

    if (scene.mode === 'legacy' && scene.cues.length > 0) {
      manifestFail(`${base}.cues`);
    }

    const phraseIds = new Set<string>();
    let previousPhraseEndMs = scene.startMs;

    for (const [phraseIndex, phrase] of scene.phrases.entries()) {
      const phraseBase = `${base}.phrases[${phraseIndex}]`;

      if (
        phrase.id.trim() === ''
        || phraseIds.has(phrase.id)
        || phrase.text.trim() === ''
        || !positiveInterval(phrase.startMs, phrase.endMs)
        || phrase.startMs + EPSILON_MS < previousPhraseEndMs
        || phrase.startMs < scene.startMs - EPSILON_MS
        || phrase.endMs > scene.endMs + EPSILON_MS
      ) {
        manifestFail(phraseBase);
      }

      phraseIds.add(phrase.id);
      previousPhraseEndMs = phrase.endMs;
    }

    const cueIds = new Set<string>();

    for (const [cueIndex, cue] of scene.cues.entries()) {
      const cueBase = `${base}.cues[${cueIndex}]`;

      if (
        cue.cueId.trim() === ''
        || cueIds.has(cue.cueId)
        || !positiveInterval(cue.speechStartMs, cue.speechEndMs)
        || cue.speechStartMs < scene.startMs - EPSILON_MS
        || cue.speechEndMs > scene.endMs + EPSILON_MS
        || cue.eventMs < scene.startMs - EPSILON_MS
        || cue.eventMs > scene.endMs + EPSILON_MS
        || cue.errorMs < 0
      ) {
        manifestFail(cueBase);
      }

      cueIds.add(cue.cueId);
    }

    sceneIds.add(scene.id);
    previousSceneEndMs = scene.endMs;
  }

  const exactScenes = manifest.scenes.filter((scene) => scene.mode === 'exact').length;
  const expectedMode = exactScenes === manifest.scenes.length
    ? 'exact'
    : exactScenes === 0
      ? 'legacy'
      : 'mixed';

  if (manifest.mode !== expectedMode) {
    manifestFail('manifest.mode');
  }

  if (
    Math.abs(manifest.totalMs - previousSceneEndMs) > EPSILON_MS
    || Math.abs(manifest.video.durationMs - manifest.totalMs)
      > SHOWCASE_MANIFEST_MEDIA_TOLERANCE_MS
  ) {
    manifestFail('manifest.totalMs');
  }

  let previousSubtitleEndMs = 0;

  for (const [cueIndex, cue] of manifest.subtitleCues.entries()) {
    const base = `manifest.subtitleCues[${cueIndex}]`;
    const scene = manifest.scenes.find((candidate) => candidate.id === cue.sceneId);

    if (
      cue.index !== cueIndex + 1
      || cue.text.trim() === ''
      || !scene
      || !positiveInterval(cue.startMs, cue.endMs)
      || cue.startMs + EPSILON_MS < previousSubtitleEndMs
      || cue.startMs < scene.startMs - EPSILON_MS
      || cue.endMs > scene.endMs + EPSILON_MS
    ) {
      manifestFail(base);
    }

    previousSubtitleEndMs = cue.endMs;
  }

  if ((manifest.subtitleCues.length > 0) !== (manifest.subtitles !== null)) {
    manifestFail('manifest.subtitles');
  }

  return manifest;
}

export interface ScenePlanInput {
  audioMs: number;
  clipMs: number;
}

/**
 * Расписание одной сцены. Общая длительность именно вычисляется, а не берётся у той
 * дорожки, которая длиннее случайно: план требует не обрезать звук ради клипа и не
 * обрывать показ ради звука.
 */
export function planScene({ audioMs, clipMs }: ScenePlanInput): ShowcaseTiming {
  const narrationStartMs = PRE_ROLL_MS;
  const speechEndMs = narrationStartMs + audioMs;
  const actionsEndMs = clipMs;

  return {
    preRollMs: PRE_ROLL_MS,
    narrationStartMs,
    speechEndMs,
    actionsEndMs,
    postRollMs: POST_ROLL_MS,
    totalMs: Math.max(speechEndMs, actionsEndMs) + POST_ROLL_MS,
  };
}

/**
 * Начало каждой сцены в собранном ролике, миллисекунды от старта. Считается по
 * плановым длинам сцен в порядке показа. Сцена без измеренной записи или звука
 * делает расчёт невозможным целиком: ролик из таких сцен не собирается, а
 * угаданное смещение уводило бы зрителя мимо сцены. Плановая длина расходится с
 * готовым файлом на доли секунды на сцену — для перехода к сцене этого достаточно.
 */
export function sceneStartsMs(scenes: ShowcaseScene[]): Map<string, number> | null {
  const ordered = [...scenes].sort((left, right) => left.order - right.order);
  const starts = new Map<string, number>();
  let offsetMs = 0;

  for (const scene of ordered) {
    const audioMs = scene.audio?.durationMs;
    const clipMs = scene.clip?.durationMs;

    if (audioMs === null || audioMs === undefined || clipMs === null || clipMs === undefined) {
      return null;
    }

    starts.set(scene.id, offsetMs);
    offsetMs += planScene({ audioMs, clipMs }).totalMs;
  }

  return starts;
}
