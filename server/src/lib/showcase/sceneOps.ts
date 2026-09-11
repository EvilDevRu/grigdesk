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
  patchScene,
  removeScene,
  reorderScenes,
  replaceScene,
  sceneOf,
} from './scenes.ts';
import type { SceneDraft } from './scenes.ts';
import type { ShowcaseProject } from '../../../../shared/showcaseContracts.ts';
import type { ShowcaseStore } from './store.ts';
import type { ShowcaseTargets } from './targets.ts';

export interface SceneOpsDeps {
  assertEnabled: () => void;
  broadcast: (event: string, data: unknown) => void;
  limits: () => { maxScenes: number; maxSceneSeconds: number };
  readProject: (id: string) => Promise<ShowcaseProject>;
  store: ShowcaseStore;
  targets: ShowcaseTargets;
  withFreshness: (project: ShowcaseProject) => ShowcaseProject;
}

export function createSceneOps(deps: SceneOpsDeps) {
  const {
    assertEnabled, broadcast, limits, readProject, store, targets, withFreshness,
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
    patch: Partial<SceneDraft>,
  ): Promise<ShowcaseProject> {
    assertEnabled();

    if (patch.screenId) {
      await screenOf(await readProject(id), patch.screenId);
    }

    const saved = await store.updateProject(id, expectedRevision, (project) => ({
      ...project,
      scenes: replaceScene(project, patchScene(sceneOf(project, sceneId), patch)),
    }));

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
    const audioSource = { kind: 'recorded' as const, voiceRef: null, artifactId: artifact.id };
    const saved = await store.updateProject(id, expectedRevision, (current) => ({
      ...current,
      scenes: replaceScene(current, {
        ...sceneOf(current, sceneId),
        audioSource,
        audio: artifact,
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
