// Операции над сценами ролика.
//
// Сцена — единица правки и единица пересъёмки, поэтому все её изменения идут
// одним путём: проверка, запись со ожидаемой редакцией, событие и ответ уже с
// пересчитанной свежестью. Расходиться этим шагам нельзя — иначе часть правок
// молча оставила бы интерфейс со старым состоянием.
//
// Артефакты при правке НЕ удаляются: они просто перестают совпадать со своими
// входами. Так правка фразы оставляет клип на месте, а откат правки возвращает
// прежнюю свежесть без повторной записи.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { publishArtifact } from './artifacts.ts';
import { ShowcaseError } from './errors.ts';
import { PRODUCER_VERSIONS } from './formats.ts';
import { normalizeImportedAudio, probeResult } from './render/assembler.ts';
import {
  createScene,
  createSyncBindings,
  patchScene,
  removeScene,
  reorderScenes,
  replaceScene,
  sceneOf,
  sceneSyncBindingsState,
  syncTextHash,
} from './scenes.ts';
import type { SceneDraft } from './scenes.ts';
import type {
  ShowcaseProject,
  ShowcaseScene,
} from '../../../../shared/showcaseContracts.ts';
import type { ShowcaseSyncCueKind } from '../../../../shared/showcaseSync.ts';
import type { ShowcaseStore } from './store.ts';
import type { ShowcaseTargets } from './targets.ts';
import { canonicalTextOf } from './voice/contract.ts';
import { checkSpeech } from './voice/speechCheck.ts';
import {
  publishSpeechAlignment,
  publishSpeechTiming,
  recordedSpeechTextInputHash,
  speechTimingFromTranscript,
} from './syncStore.ts';
import type { SpeechTranscript } from '../speech/transport.ts';
import { alignSpeechTiming } from './voice/alignment.ts';
import {
  createPronunciationOverrides,
} from './voice/preparation.ts';
import type { PronunciationOverrideInput } from './voice/preparation.ts';

export interface SceneSyncCueInput {
  // ID можно только вернуть из текущей сцены. Для новой связи он отсутствует, а
  // сервер создаёт его сам; произвольный ID клиента не становится сохранённым.
  id?: string | null;
  actionIndex: number;
  from: number;
  to: number;
  kind: ShowcaseSyncCueKind;
  // Клиент может только закрепить связь как ручную. Вернуть её в generated через
  // HTTP нельзя: этот origin принадлежит исключительно проверенному ответу модели.
  manual?: true;
}

export interface SceneUpdatePatch extends Partial<SceneDraft> {
  syncCues?: SceneSyncCueInput[];
  pronunciationOverrides?: PronunciationOverrideInput[];
}

function sameCue(
  current: NonNullable<ShowcaseScene['syncBindings']>['cues'][number],
  input: SceneSyncCueInput,
): boolean {
  return current.actionIndex === input.actionIndex
    && current.from === input.from
    && current.to === input.to
    && current.kind === input.kind;
}

/**
 * Применяет полный ручной список cue к текущей редакции сцены. Известный неизменённый
 * cue сохраняет ID и origin; исправленный становится manual. Устаревший документ
 * можно починить тем же действием, но нельзя подсунуть ID из другой сцены.
 */
export function applyManualSyncCues(
  scene: ShowcaseScene,
  inputs: readonly SceneSyncCueInput[],
): ShowcaseScene {
  if (inputs.length === 0) {
    return patchScene(scene, { syncBindings: null });
  }

  const previous = new Map((scene.syncBindings?.cues ?? []).map((cue) => [cue.id, cue]));
  const previousState = sceneSyncBindingsState(scene);
  const generated = createSyncBindings(
    scene.narration,
    scene.actions,
    inputs.map((input) => ({
      actionIndex: input.actionIndex,
      from: input.from,
      to: input.to,
      kind: input.kind,
      origin: 'manual',
    })),
  );

  const cues = generated.cues.map((cue, index) => {
    const input = inputs[index] as SceneSyncCueInput;

    if (!input.id) {
      return cue;
    }

    const known = previous.get(input.id);

    if (!known) {
      throw new ShowcaseError(
        'bad_sync_bindings',
        `Привязка «${input.id}» не принадлежит текущей сцене.`,
        400,
      );
    }

    if (input.manual !== true && previousState.status === 'valid' && sameCue(known, input)) {
      return known;
    }

    return { ...cue, id: known.id, origin: 'manual' as const };
  });

  return patchScene(scene, { syncBindings: { ...generated, cues } });
}

/**
 * Заменяет только модельные cue, оставляя ручные объектами с теми же ID. Если
 * ручная связь уже устарела, модель не угадывает её новый смысл: сцену должен
 * исправить человек.
 */
export function applyGeneratedSyncCues(
  scene: ShowcaseScene,
  inputs: readonly Omit<SceneSyncCueInput, 'id'>[],
): ShowcaseScene {
  const previousState = sceneSyncBindingsState(scene);
  const manual = (scene.syncBindings?.cues ?? []).filter((cue) => cue.origin === 'manual');

  if (manual.length > 0 && previousState.status !== 'valid') {
    throw new ShowcaseError(
      'stale_manual_bindings',
      `Ручные привязки сцены «${scene.title}» потеряли актуальность. Исправьте эту сцену.`,
      409,
    );
  }

  if (manual.length === 0 && inputs.length === 0) {
    return patchScene(scene, { syncBindings: null });
  }

  const generated = createSyncBindings(
    scene.narration,
    scene.actions,
    inputs.map((input) => ({ ...input, origin: 'generated' })),
  );

  return patchScene(scene, {
    syncBindings: {
      ...generated,
      cues: [...manual, ...generated.cues],
    },
  });
}

export interface SceneOpsDeps {
  assertEnabled: () => void;
  broadcast: (event: string, data: unknown) => void;
  limits: () => { maxScenes: number; maxSceneSeconds: number };
  readProject: (id: string) => Promise<ShowcaseProject>;
  store: ShowcaseStore;
  targets: ShowcaseTargets;
  transcribe: ((file: string) => Promise<string | SpeechTranscript>) | null;
  withFreshness: (project: ShowcaseProject) => ShowcaseProject;
}

export function createSceneOps(deps: SceneOpsDeps) {
  const {
    assertEnabled, broadcast, limits, readProject, store, targets, transcribe, withFreshness,
  } = deps;

  /**
   * Экран сцены по карте профиля. Сцена ссылается на объявленный экран, а не носит
   * свой адрес: иначе правка объявления профиля перестала бы влиять на запись.
   */
  async function screenOf(project: ShowcaseProject, screenId: string) {
    if (project.target.status !== 'ready') {
      throw new ShowcaseError('target_unavailable', project.target.reason, 409);
    }

    const scope = await targets.resolveSelected(project.ref, project.target.scope.profile);

    if (scope.status !== 'ready') {
      throw new ShowcaseError('target_unavailable', scope.reason, 409);
    }

    const screen = scope.scope.screens.find((item) => item.id === screenId);

    if (!screen) {
      throw new ShowcaseError(
        'unknown_screen',
        `Экран «${screenId}» недоступен для этой цели.`,
        400,
      );
    }

    return screen;
  }

  async function addScene(
    id: string,
    expectedRevision: number,
    draft: SceneDraft,
  ): Promise<ShowcaseProject> {
    assertEnabled();

    const current = await readProject(id);
    const sceneLimits = limits();

    if (current.scenes.length >= sceneLimits.maxScenes) {
      throw new ShowcaseError(
        'too_many_scenes',
        `В ролике уже ${current.scenes.length} сцен: предел ${sceneLimits.maxScenes}.`,
        409,
      );
    }

    await screenOf(current, draft.screenId);

    const saved = await store.updateProject(id, expectedRevision, (project) => ({
      ...project,
      scenes: [...project.scenes, createScene(project, draft)],
    }));

    broadcast('showcase-changed', { projectId: id, revision: saved.revision });

    return withFreshness(saved);
  }

  /**
   * Правка сцены. Артефакты НЕ удаляются: они просто перестают совпадать со своими
   * входами. Так правка фразы оставляет клип на месте, а откат правки возвращает
   * прежнюю свежесть без повторной записи.
   */
  async function updateScene(
    id: string,
    expectedRevision: number,
    sceneId: string,
    patch: SceneUpdatePatch,
  ): Promise<ShowcaseProject> {
    assertEnabled();

    if (patch.screenId) {
      await screenOf(await readProject(id), patch.screenId);
    }

    const { pronunciationOverrides, syncCues, ...scenePatch } = patch;

    const saved = await store.updateProject(id, expectedRevision, (project) => {
      const previous = sceneOf(project, sceneId);
      const changed = patchScene(previous, scenePatch);
      const withPronunciation = pronunciationOverrides === undefined
        ? changed
        : {
          ...changed,
          pronunciationOverrides: createPronunciationOverrides(
            changed.narration,
            pronunciationOverrides,
            previous.pronunciationOverrides ?? [],
          ),
        };
      const withBindings = syncCues === undefined
        ? withPronunciation
        : applyManualSyncCues(withPronunciation, syncCues);

      return {
        ...project,
        scenes: replaceScene(project, withBindings),
      };
    });

    broadcast('showcase-changed', { projectId: id, revision: saved.revision });

    return withFreshness(saved);
  }

  /**
   * Перестановка сцен. Артефакты сцен остаются прежними — переставленная сцена это
   * та же сцена, — а вот итог и абсолютные таймкоды субтитров меняются всегда.
   */
  async function reorder(
    id: string,
    expectedRevision: number,
    order: string[],
  ): Promise<ShowcaseProject> {
    assertEnabled();

    const saved = await store.updateProject(id, expectedRevision, (project) => ({
      ...project,
      scenes: reorderScenes(project, order),
    }));

    broadcast('showcase-changed', { projectId: id, revision: saved.revision });

    return withFreshness(saved);
  }

  async function deleteScene(
    id: string,
    expectedRevision: number,
    sceneId: string,
  ): Promise<ShowcaseProject> {
    assertEnabled();

    const saved = await store.updateProject(id, expectedRevision, (project) => ({
      ...project,
      scenes: removeScene(project, sceneId),
    }));

    broadcast('showcase-changed', { projectId: id, revision: saved.revision });

    return withFreshness(saved);
  }

  /**
   * Загрузка готового звука сцены. Файл приводится к общему PCM-профилю и только
   * потом становится артефактом: дальше по конвейеру и таймлайн, и сведение считают
   * частоту и число каналов известными, а WAV человека приходит каким угодно.
   *
   * Загруженная запись — полноправный источник, а не поддельный синтез: автоматически
   * переозвучивать её нельзя, поэтому её хеш входов считается по самому файлу.
   */
  async function importSceneAudio(
    id: string,
    expectedRevision: number,
    sceneId: string,
    sourceFile: string,
  ): Promise<ShowcaseProject> {
    assertEnabled();

    const project = await readProject(id);
    const scene = sceneOf(project, sceneId);
    const names = store.namesOf(id);
    const sceneDir = path.join(names.scenesDir, scene.id, 'artifacts');
    const normalized = path.join(names.dir, `import-${scene.id}.wav`);

    await fs.mkdir(names.dir, { recursive: true });
    await normalizeImportedAudio(sourceFile, normalized);

    const probed = await probeResult(normalized);

    if (!probed.audio || probed.durationMs <= 0) {
      await fs.rm(normalized, { force: true });

      throw new ShowcaseError('bad_audio', 'В загруженном файле нет звуковой дорожки.', 400);
    }

    const sceneLimits = limits();

    if (probed.durationMs > sceneLimits.maxSceneSeconds * 1000) {
      await fs.rm(normalized, { force: true });

      throw new ShowcaseError(
        'audio_too_long',
        `Звук сцены длиннее предела ${sceneLimits.maxSceneSeconds} с.`,
        409,
      );
    }

    const expectedText = canonicalTextOf(scene.narration);
    const check = await checkSpeech({
      audioFile: normalized,
      expectedText,
      transcribe,
    });

    const published = await publishArtifact({
      file: normalized,
      kind: 'audio',
      // Хеш входов ставится равным хешу содержимого: вход загруженной записи — она
      // сама, и считать его от чего-то ещё значило бы старить её чужой правкой.
      inputHash: '',
      producerVersion: PRODUCER_VERSIONS.voice,
      durationMs: probed.durationMs,
      targetDir: sceneDir,
    });
    const artifact = { ...published, inputHash: published.contentHash };
    const measuredTiming = speechTimingFromTranscript(check.transcript);
    const speechTiming = await publishSpeechTiming({
      timing: measuredTiming,
      // Raw ASR измеряет WAV, а не каноническую подпись. Правка текста должна
      // пересчитать только отдельное alignment, не запускать Whisper повторно.
      sceneInputHash: artifact.contentHash,
      audioContentHash: artifact.contentHash,
      producerVersion: `whisper:${String(check.transcript?.model ?? 'unknown')}`,
      durationMs: check.durationMs,
      targetDir: sceneDir,
    });
    const textHash = syncTextHash(expectedText);
    const speechAlignment = speechTiming && measuredTiming
      ? await publishSpeechAlignment({
        alignment: alignSpeechTiming({
          canonicalText: expectedText,
          durationMs: check.durationMs,
          timing: measuredTiming,
        }),
        canonicalText: expectedText,
        textHash,
        audioContentHash: artifact.contentHash,
        speechTimingContentHash: speechTiming.contentHash,
        targetDir: sceneDir,
      })
      : null;
    const audioSource = { kind: 'recorded' as const, voiceRef: null, artifactId: artifact.id };
    const saved = await store.updateProject(id, expectedRevision, (current) => ({
      ...current,
      scenes: replaceScene(current, {
        ...sceneOf(current, sceneId),
        audioSource,
        audio: artifact,
        speechTiming,
        speechAlignment,
        checks: [
          ...sceneOf(current, sceneId).checks.filter((entry) => entry.kind !== 'speech'),
          {
            id: `speech-${artifact.id}`,
            kind: 'speech' as const,
            status: check.status,
            inputHash: recordedSpeechTextInputHash(expectedText),
            artifactId: artifact.id,
            reason: [check.reason, check.loudnessWarning].filter(Boolean).join(' '),
            textRange: null,
            suggestions: check.missingWords.length > 0
              ? [`Не слышно: ${check.missingWords.join(', ')}`]
              : [],
          },
        ],
      }),
    }));

    broadcast('showcase-changed', { projectId: id, revision: saved.revision });

    return withFreshness(saved);
  }

  return {
    addScene,
    deleteScene,
    importSceneAudio,
    reorder,
    screenOf,
    updateScene,
  };
}
