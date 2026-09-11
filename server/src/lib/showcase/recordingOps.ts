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
import { toPublicScope } from './targets.ts';
import type { ShowcaseTargets } from './targets.ts';
import type { SandboxActivityLease } from '../sandboxes/activityGuard.ts';

export interface RecordingOpsDeps {
  assertEnabled: () => void;
  // Снимки запущенных исполнителей общие с опросом: по ним читаются журнал
  // попытки и её итог.
  attempts: Map<string, WorkerHandle>;
  broadcast: (event: string, data: unknown) => void;
  resolveBrowserPath: () => Promise<string | null>;
  inputsOf: (project: ShowcaseProject) => ArtifactInputs;
  jobs: ShowcaseJobs;
  limits: () => { maxSceneSeconds: number; maxTotalSeconds: number };
  acquireTargetLease: (ref: ShowcaseProject['ref']) => Promise<SandboxActivityLease | null>;
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

    const lease = await deps.acquireTargetLease(project.ref);

    try {
      const internal = await targets.selectedInternalScope(
        project.ref,
        project.target.scope.profile,
        project.target.scope.targetFingerprint,
      );

      if (!internal.capabilities.includes('record')) {
        throw new ShowcaseError(
          'record_not_allowed',
          'Запись не разрешена для этой цели.',
          409,
        );
      }

      const browserPath = await deps.resolveBrowserPath();

      if (!browserPath || !(await fs.access(browserPath).then(() => true).catch(() => false))) {
        throw new ShowcaseError(
          'browser_missing',
          'Браузер записи не установлен: поставьте Chromium в настройках плагина «Презентации».',
          503,
        );
      }

      const inputs = inputsOf({
        ...project,
        target: { status: 'ready', ref: project.ref, scope: toPublicScope(internal) },
      });
      const pending = project.scenes
        .filter((scene) => !sceneFreshness(scene, inputs).clip)
        .sort((left, right) => left.order - right.order);

      if (pending.length === 0) {
        throw new ShowcaseError('nothing_to_record', 'Все клипы сцен уже свежие.', 409);
      }

      const scenes = pending.map((scene) => {
        const screen = internal.screens.find((item) => item.id === scene.screenId);

        if (!screen) {
          throw new ShowcaseError(
            'unknown_screen',
            `Экран «${scene.screenId}» недоступен для этой цели.`,
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
      const login = await loginTaskOf(internal);

      await lease?.assertPathIdentity();

      const handle = await launchWorker({
        workDir: path.join(store.jobsDir, record.id, 'work'),
        task: {
          jobId: record.id,
          projectId: id,
          baseUrl: internal.recordUrl,
          allowedOrigins: internal.allowedOrigins,
          allowedMethods: internal.allowedMethods,
          browserPath,
          style: RENDER_STYLE,
          deadlineMs: Math.min(limits.maxSceneSeconds * 1000 + 60_000, 300_000),
          login,
          scenes,
        },
        inheritedFds: lease ? [lease.inheritedFd()] : undefined,
      });

      attempts.set(record.id, handle);

      return toPublicJob(await jobs.progress(record.id, {
        sequence: record.sequence + 1,
        label: 'исполнитель записи запущен',
        total: scenes.length,
        identity: handle.identity,
      }));
    } finally {
      // Успешный worker получил копию OFD; при ошибке spawn её не существует.
      await lease?.release();
    }
  }

  /**
   * Вход для исполнителя: селекторы из объявления профиля и учётка по ссылке из
   * него же. Объявленный, но не найденный секрет — отказ до записи: снимать стенд
   * с формой входа вместо экранов бессмысленно, а причину лучше назвать сразу.
   */
  async function loginTaskOf(
    internal: Awaited<ReturnType<ShowcaseTargets['selectedInternalScope']>>,
  ) {
    if (!internal.login || !internal.capabilities.includes('login')) {
      return null;
    }

    const credentials = await targets.loginCredentialsOf(internal);

    if (!credentials) {
      throw new ShowcaseError(
        'login_credentials_missing',
        'Учётка для входа на стенд не найдена по ссылке из login.json профиля.',
        409,
      );
    }

    return {
      url: internal.login.url,
      userSelector: internal.login.userSelector,
      passwordSelector: internal.login.passwordSelector,
      submitSelector: internal.login.submitSelector,
      readySelector: internal.login.readySelector,
      user: credentials.user,
      password: credentials.password,
    };
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
