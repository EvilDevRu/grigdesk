// Запись сцен браузером и публикация снятых клипов.
//
// В задание идут только сцены, чей клип не совпадает со своими входами: правка
// одной сцены не заставляет переснимать соседние, и ради этого свежесть вообще
// считается хешами.
//
// Сервер — единственный, кто публикует ссылки на клипы. Исполнитель пишет отчёт
// своей попытки, а сервер сверяет хеши входов заново: поздний отчёт старой попытки
// не должен заменить собой свежий результат.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { clipInputHash, publishArtifact, sceneFreshness } from './artifacts.ts';
import type { ArtifactInputs } from './artifacts.ts';
import { ShowcaseError } from './errors.ts';
import { PRODUCER_VERSIONS, RENDER_STYLE } from './formats.ts';
import { toPublicJob } from './jobs.ts';
import type { ShowcaseJobs } from './jobs.ts';
import { launchWorker } from './render/runner.ts';
import type { WorkerHandle, WorkerResult as WorkerOutcome } from './render/runner.ts';
import type {
  ShowcaseArtifactRef,
  ShowcaseJob,
  ShowcaseProject,
} from '../../../../shared/showcaseContracts.ts';
import type { ShowcaseStore } from './store.ts';
import type { ShowcaseTargets } from './targets.ts';

export interface RecordingOpsDeps {
  assertEnabled: () => void;
  // Снимки запущенных исполнителей общие с опросом: по ним читаются журнал
  // попытки и её итог.
  attempts: Map<string, WorkerHandle>;
  broadcast: (event: string, data: unknown) => void;
  browserPath: string | null;
  inputsOf: (project: ShowcaseProject) => ArtifactInputs;
  jobs: ShowcaseJobs;
  limits: () => { maxSceneSeconds: number; maxTotalSeconds: number };
  readProject: (id: string) => Promise<ShowcaseProject>;
  store: ShowcaseStore;
  targets: ShowcaseTargets;
}

export function createRecordingOps(deps: RecordingOpsDeps) {
  const {
    assertEnabled, attempts, broadcast, inputsOf, jobs, readProject, store, targets,
  } = deps;

  /**
   * Запись сцен браузером. В задание идут только сцены, чей клип не совпадает со
   * своими входами: правка одной сцены не заставляет переснимать соседние, и это
   * основная причина, ради которой свежесть вообще считается хешами.
   */
  async function startRecording(id: string): Promise<ShowcaseJob> {
    assertEnabled();

    const project = await readProject(id);

    if (project.target.status !== 'ready') {
      throw new ShowcaseError('target_unavailable', project.target.reason, 409);
    }

    if (!project.target.scope.capabilities.includes('record')) {
      throw new ShowcaseError(
        'record_not_allowed',
        'Профиль не объявил запись для этой цели.',
        409,
      );
    }

    const browserPath = deps.browserPath;

    if (!browserPath || !(await fs.access(browserPath).then(() => true).catch(() => false))) {
      throw new ShowcaseError(
        'browser_missing',
        'Браузер записи не установлен: установка — отдельное действие настройки.',
        503,
      );
    }

    const scope = await targets.resolve(project.ref, project.target.scope.profile);

    if (scope.status !== 'ready') {
      throw new ShowcaseError('target_unavailable', scope.reason, 409);
    }

    const inputs = inputsOf(project);
    const pending = project.scenes
      .filter((scene) => !sceneFreshness(scene, inputs).clip)
      .sort((left, right) => left.order - right.order);

    if (pending.length === 0) {
      throw new ShowcaseError('nothing_to_record', 'Все клипы сцен уже свежие.', 409);
    }

    const internal = await targets.internalScope(project.ref, project.target.scope.profile);
    const scenes = pending.map((scene) => {
      const screen = internal.screens.find((item) => item.id === scene.screenId);

      if (!screen) {
        throw new ShowcaseError(
          'unknown_screen',
          `Профиль не объявлял экран «${scene.screenId}».`,
          400,
        );
      }

      return { scene, screen };
    });
    const inputHashes = Object.fromEntries(
      pending.map((scene) => [scene.id, clipInputHash(scene, inputs)]),
    );
    const { record, reused } = await jobs.enqueue({
      projectId: id,
      kind: 'record',
      idempotencyKey: createHash('sha256')
        .update(`record:${id}:${JSON.stringify(inputHashes)}`)
        .digest('hex')
        .slice(0, 32),
      inputHashes,
      inputRevision: project.revision,
    });

    if (reused) {
      return toPublicJob(record);
    }

    const limits = deps.limits();
    const handle = await launchWorker({
      workDir: path.join(store.jobsDir, record.id, 'work'),
      task: {
        jobId: record.id,
        projectId: id,
        baseUrl: internal.recordUrl,
        allowedOrigins: internal.allowedOrigins,
        browserPath,
        style: RENDER_STYLE,
        deadlineMs: Math.min(limits.maxSceneSeconds * 1000 + 60_000, 300_000),
        scenes,
      },
    });

    attempts.set(record.id, handle);

    return toPublicJob(await jobs.progress(record.id, {
      sequence: record.sequence + 1,
      label: 'исполнитель записи запущен',
      total: scenes.length,
      identity: handle.identity,
    }));
  }

  /**
   * Публикация результата записи. Хеши входов сверяются с текущими: пока шла
   * запись, человек мог поправить сцену, и тогда её клип — уже не то, что нужно.
   * Такой результат остаётся файлом на диске, но актуальной ссылкой не становится.
   */
  async function publishRecording(jobId: string, result: WorkerOutcome): Promise<void> {
    const job = jobs.read(jobId);
    const project = await readProject(job.projectId);
    const inputs = inputsOf(project);
    const names = store.namesOf(job.projectId);
    const published: { sceneId: string; artifact: ShowcaseArtifactRef }[] = [];

    for (const scene of result.scenes) {
      const current = project.scenes.find((item) => item.id === scene.sceneId);

      if (!current) {
        continue;
      }

      const expected = job.inputHashes[scene.sceneId];

      if (!expected || expected !== clipInputHash(current, inputs)) {
        continue;
      }

      published.push({
        sceneId: scene.sceneId,
        artifact: await publishArtifact({
          file: scene.rawPath,
          kind: 'clip',
          inputHash: expected,
          producerVersion: PRODUCER_VERSIONS.recorder,
          durationMs: scene.durationMs,
          targetDir: path.join(names.scenesDir, scene.sceneId, 'artifacts'),
        }),
      });
    }

    if (published.length === 0) {
      return;
    }

    const saved = await store.updateProject(job.projectId, null, (current) => ({
      ...current,
      scenes: current.scenes.map((scene) => {
        const own = published.find((item) => item.sceneId === scene.id);

        return own ? { ...scene, clip: own.artifact } : scene;
      }),
    }));

    broadcast('showcase-changed', { projectId: job.projectId, revision: saved.revision });
  }

  return { publishRecording, startRecording };
}
