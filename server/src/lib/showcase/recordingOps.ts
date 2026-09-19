// Запись сцен браузером и публикация снятых клипов.
//
// В задание идут только сцены, чей клип не совпадает со своими входами: правка
// одной сцены не заставляет переснимать соседние, и ради этого свежесть вообще
// считается хешами. Исключение — цепочка: продолжение начинается там, где
// закончилась предыдущая сцена, и переснять его отдельно от головы нельзя, поэтому
// устаревшая сцена тянет в задание всю свою цепочку.
//
// Сервер — единственный, кто публикует ссылки на клипы. Исполнитель пишет отчёт
// своей попытки, а сервер сверяет хеши входов заново: поздний отчёт старой попытки
// не должен заменить собой свежий результат.
import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import { clipInputHash, publishArtifact, sceneFreshness } from './artifacts.ts';
import type { ArtifactInputs } from './artifacts.ts';
import { chainLineage, sceneChains } from '../../../../shared/showcaseChains.ts';
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
import { syncActionsHash } from './scenes.ts';
import { resolvableElements, screenFromPageId } from './script/observation.ts';
import { readScriptProof } from './script/verification.ts';
import type {
  RecordingTimingCandidate,
  RecordingTimingUnavailableCandidate,
  RecordingTimingWorkerCandidate,
  ScreenMap,
} from './render/recorder.ts';
import type { ShowcaseDerivedArtifactRef } from '../../../../shared/showcaseContracts.ts';

export const RECORDING_TIMING_VERSION = 1 as const;
export const RECORDING_TIMING_PRODUCER_VERSION = 'recording-timing-1';

const RECORDING_TIMING_ID = /^recording-timing-[a-f0-9]{12}$/;
const MAX_CALIBRATION_ERROR_MS = 100;

interface RecordingTimingDocumentCommon {
  version: typeof RECORDING_TIMING_VERSION;
  clipContentHash: string;
  actionsHash: string;
  producerVersion: string;
}

export type RecordingTimingDocument = RecordingTimingDocumentCommon
  & RecordingTimingWorkerCandidate;

function timingHash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function recordingTimingInputHash(
  sceneInputHash: string,
  clipContentHash: string,
  actionsHash: string,
): string {
  return timingHash(JSON.stringify({
    version: RECORDING_TIMING_VERSION,
    kind: 'recording-timing',
    sceneInputHash,
    clipContentHash,
    actionsHash,
  }));
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function geometryOf(value: unknown): RecordingTimingCandidate['actions'][number]['geometry'] | undefined {
  if (value === null) {
    return null;
  }

  const source = objectRecord(value);

  if (
    !source
    || !finiteNonNegative(source.x)
    || !finiteNonNegative(source.y)
    || !finiteNonNegative(source.width)
    || !finiteNonNegative(source.height)
    || source.width <= 0
    || source.height <= 0
    || source.x + source.width > RENDER_STYLE.width
    || source.y + source.height > RENDER_STYLE.height
  ) {
    return undefined;
  }

  return { x: source.x, y: source.y, width: source.width, height: source.height };
}

/** Runtime codec worker metadata: invalid JSON can only remove the derived log. */
function timingCandidateOf(
  value: unknown,
  expectedActions: ShowcaseProject['scenes'][number]['actions'],
): RecordingTimingCandidate | null {
  const source = objectRecord(value);
  const calibration = objectRecord(source?.calibration);
  const frameMs = 1000 / RENDER_STYLE.fps;

  if (
    !source
    || source.status !== 'calibrated'
    || !finiteNonNegative(source.durationMs)
    || source.durationMs <= 0
    || Math.abs(source.durationMs / frameMs - Math.round(source.durationMs / frameMs)) > 1e-6
    || !finiteNonNegative(source.sceneReadyMs)
    || source.sceneReadyMs > source.durationMs
    || !calibration
    || calibration.method !== 'visual-marker-affine-v1'
    || !finiteNonNegative(calibration.errorMs)
    || !finiteNonNegative(calibration.startErrorMs)
    || !finiteNonNegative(calibration.endErrorMs)
    || calibration.errorMs > MAX_CALIBRATION_ERROR_MS
    || calibration.startErrorMs > calibration.errorMs
    || calibration.endErrorMs > calibration.errorMs
    || typeof calibration.rate !== 'number'
    || !Number.isFinite(calibration.rate)
    || calibration.rate < 0.98
    || calibration.rate > 1.02
    || !Array.isArray(source.actions)
    || source.actions.length !== expectedActions.length
    || !Array.isArray(source.stableIntervals)
    || !Array.isArray(source.removableWaits)
    || !Array.isArray(source.highlights)
  ) {
    return null;
  }

  const actions: RecordingTimingCandidate['actions'] = [];
  let previousEndMs = 0;

  for (const [index, valueAction] of source.actions.entries()) {
    const action = objectRecord(valueAction);
    const geometry = geometryOf(action?.geometry);

    if (
      !action
      || action.actionIndex !== index
      || action.kind !== expectedActions[index]?.kind
      || !finiteNonNegative(action.startMs)
      || !finiteNonNegative(action.anchorMs)
      || !finiteNonNegative(action.endMs)
      || action.startMs + 0.01 < previousEndMs
      || action.startMs > action.anchorMs + 0.01
      || action.anchorMs > action.endMs + 0.01
      || action.endMs > source.durationMs + 0.01
      || geometry === undefined
      || (action.readyMs !== null && (
        !finiteNonNegative(action.readyMs)
        || action.readyMs < action.anchorMs - 0.01
        || action.readyMs > action.endMs + 0.01
      ))
    ) {
      return null;
    }

    actions.push({
      actionIndex: index,
      kind: expectedActions[index]?.kind as typeof expectedActions[number]['kind'],
      startMs: action.startMs,
      anchorMs: action.anchorMs,
      endMs: action.endMs,
      readyMs: action.readyMs as number | null,
      geometry,
    });
    previousEndMs = action.endMs;
  }

  const stableIntervals: RecordingTimingCandidate['stableIntervals'] = [];
  const stableIds = new Set<string>();

  for (const raw of source.stableIntervals) {
    const interval = objectRecord(raw);

    if (
      !interval
      || typeof interval.id !== 'string'
      || interval.id.trim() === ''
      || stableIds.has(interval.id)
      || !finiteNonNegative(interval.fromMs)
      || !finiteNonNegative(interval.toMs)
      || !finiteNonNegative(interval.frameMs)
      || interval.fromMs >= interval.toMs
      || interval.fromMs > interval.frameMs + 0.01
      || interval.frameMs > interval.toMs + 0.01
      || interval.toMs > source.durationMs + 0.01
      || Math.abs(interval.frameMs / frameMs - Math.round(interval.frameMs / frameMs)) > 1e-6
      || !(interval.afterActionIndex === null
        || Number.isSafeInteger(interval.afterActionIndex)
          && (interval.afterActionIndex as number) >= 0
          && (interval.afterActionIndex as number) < actions.length)
      || !(interval.beforeActionIndex === null
        || Number.isSafeInteger(interval.beforeActionIndex)
          && (interval.beforeActionIndex as number) >= 0
          && (interval.beforeActionIndex as number) < actions.length)
    ) {
      return null;
    }

    stableIds.add(interval.id);
    stableIntervals.push({
      id: interval.id,
      fromMs: interval.fromMs,
      toMs: interval.toMs,
      frameMs: interval.frameMs,
      afterActionIndex: interval.afterActionIndex as number | null,
      beforeActionIndex: interval.beforeActionIndex as number | null,
    });
  }

  const removableWaits: RecordingTimingCandidate['removableWaits'] = [];

  for (const raw of source.removableWaits) {
    const wait = objectRecord(raw);

    if (
      !wait
      || typeof wait.id !== 'string'
      || !finiteNonNegative(wait.fromMs)
      || !finiteNonNegative(wait.toMs)
      || wait.fromMs >= wait.toMs
      || wait.toMs > source.durationMs + 0.01
      || !(wait.actionIndex === null
        || Number.isSafeInteger(wait.actionIndex)
          && expectedActions[wait.actionIndex as number]?.kind === 'wait')
      || !(wait.beforeActionIndex === null
        || Number.isSafeInteger(wait.beforeActionIndex)
          && (wait.beforeActionIndex as number) >= 0
          && (wait.beforeActionIndex as number) < actions.length)
    ) {
      return null;
    }

    removableWaits.push({
      id: wait.id,
      fromMs: wait.fromMs,
      toMs: wait.toMs,
      actionIndex: wait.actionIndex as number | null,
      beforeActionIndex: wait.beforeActionIndex as number | null,
    });
  }

  const highlights: RecordingTimingCandidate['highlights'] = [];

  for (const raw of source.highlights) {
    const highlight = objectRecord(raw);
    const geometry = geometryOf(highlight);

    if (
      !highlight
      || geometry === undefined
      || geometry === null
      || !Number.isSafeInteger(highlight.actionIndex)
      || expectedActions[highlight.actionIndex as number]?.kind !== 'highlight'
      || !finiteNonNegative(highlight.validFromMs)
      || !finiteNonNegative(highlight.validToMs)
      || highlight.validFromMs >= highlight.validToMs
      || highlight.validToMs > source.durationMs + 0.01
      || typeof highlight.stableIntervalId !== 'string'
      || !stableIds.has(highlight.stableIntervalId)
    ) {
      return null;
    }

    highlights.push({
      actionIndex: highlight.actionIndex as number,
      ...geometry,
      validFromMs: highlight.validFromMs,
      validToMs: highlight.validToMs,
      stableIntervalId: highlight.stableIntervalId,
    });
  }

  return {
    status: 'calibrated',
    durationMs: source.durationMs,
    sceneReadyMs: source.sceneReadyMs,
    calibration: {
      method: 'visual-marker-affine-v1',
      errorMs: calibration.errorMs,
      startErrorMs: calibration.startErrorMs,
      endErrorMs: calibration.endErrorMs,
      rate: calibration.rate,
    },
    actions,
    stableIntervals,
    removableWaits,
    highlights,
  };
}

function unavailableTimingOf(value: unknown): RecordingTimingUnavailableCandidate | null {
  const source = objectRecord(value);
  const calibration = objectRecord(source?.calibration);
  const frameMs = 1000 / RENDER_STYLE.fps;

  if (
    !source
    || source.status !== 'unavailable'
    || !finiteNonNegative(source.durationMs)
    || source.durationMs <= 0
    || Math.abs(source.durationMs / frameMs - Math.round(source.durationMs / frameMs)) > 1e-6
    || !calibration
    || calibration.method !== 'visual-marker-affine-v1'
    || typeof calibration.reason !== 'string'
    || calibration.reason.trim() === ''
    || calibration.reason.length > 1_000
  ) {
    return null;
  }

  return {
    status: 'unavailable',
    durationMs: source.durationMs,
    calibration: {
      method: 'visual-marker-affine-v1',
      reason: calibration.reason,
    },
  };
}

export async function publishRecordingTiming(input: {
  timing: unknown;
  sceneInputHash: string;
  clipContentHash: string;
  actions: ShowcaseProject['scenes'][number]['actions'];
  targetDir: string;
}): Promise<ShowcaseDerivedArtifactRef | null> {
  const timing = objectRecord(input.timing)?.status === 'unavailable'
    ? unavailableTimingOf(input.timing)
    : timingCandidateOf(input.timing, input.actions);

  if (!timing) {
    return null;
  }

  const actionsHash = syncActionsHash(input.actions);
  const document: RecordingTimingDocument = {
    version: RECORDING_TIMING_VERSION,
    clipContentHash: input.clipContentHash,
    actionsHash,
    producerVersion: PRODUCER_VERSIONS.recorder,
    ...timing,
  };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  const contentHash = timingHash(bytes);
  const id = `recording-timing-${randomBytes(6).toString('hex')}`;
  const file = path.join(input.targetDir, `${id}.json`);
  const temporary = `${file}.tmp-${randomBytes(4).toString('hex')}`;

  await fs.mkdir(input.targetDir, { recursive: true, mode: 0o700 });

  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => null);
    throw error;
  }

  return {
    id,
    inputHash: recordingTimingInputHash(input.sceneInputHash, input.clipContentHash, actionsHash),
    contentHash,
    producerVersion: RECORDING_TIMING_PRODUCER_VERSION,
    byteSize: bytes.length,
  };
}

export async function readRecordingTiming(input: {
  ref: ShowcaseDerivedArtifactRef;
  sceneInputHash: string;
  clipContentHash: string;
  actions: ShowcaseProject['scenes'][number]['actions'];
  targetDir: string;
}): Promise<RecordingTimingDocument | null> {
  const actionsHash = syncActionsHash(input.actions);

  if (
    !RECORDING_TIMING_ID.test(input.ref.id)
    || input.ref.producerVersion !== RECORDING_TIMING_PRODUCER_VERSION
    || input.ref.inputHash !== recordingTimingInputHash(
      input.sceneInputHash,
      input.clipContentHash,
      actionsHash,
    )
  ) {
    return null;
  }

  const bytes = await fs.readFile(path.join(input.targetDir, `${input.ref.id}.json`)).catch(() => null);

  if (
    !bytes
    || bytes.length !== input.ref.byteSize
    || timingHash(bytes) !== input.ref.contentHash
  ) {
    return null;
  }

  try {
    const source = objectRecord(JSON.parse(bytes.toString('utf8')));

    if (
      !source
      || source.version !== RECORDING_TIMING_VERSION
      || source.clipContentHash !== input.clipContentHash
      || source.actionsHash !== actionsHash
      || source.producerVersion !== PRODUCER_VERSIONS.recorder
    ) {
      return null;
    }

    const timing = source.status === 'unavailable'
      ? unavailableTimingOf(source)
      : timingCandidateOf(source, input.actions);

    return timing ? {
      version: RECORDING_TIMING_VERSION,
      clipContentHash: input.clipContentHash,
      actionsHash,
      producerVersion: PRODUCER_VERSIONS.recorder,
      ...timing,
    } : null;
  } catch {
    return null;
  }
}

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
   * основная причина, ради которой свежесть вообще считается хешами. Цепочка при
   * этом идёт целиком: её свежие сцены переснимаются вместе с устаревшей, потому
   * что состояние экрана для продолжения даёт только запись с головы.
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
      const lineageOf = (sceneId: string) => chainLineage(project.scenes, sceneId);
      const names = store.namesOf(id);
      const proof = await readScriptProof(names.dir, project);

      if (project.scriptProofHash && !proof) {
        throw new ShowcaseError('script_proof_stale', 'Сценарий изменился после проверки на стенде.', 409);
      }
      const timingCurrent = new Map<string, boolean>();

      await Promise.all(project.scenes.map(async (scene) => {
        const clipCurrent = sceneFreshness(scene, inputs, lineageOf(scene.id)).clip;

        if (!clipCurrent || !scene.clip || !scene.recordingTiming) {
          timingCurrent.set(scene.id, false);
          return;
        }

        const document = await readRecordingTiming({
          ref: scene.recordingTiming,
          sceneInputHash: scene.clip.inputHash,
          clipContentHash: scene.clip.contentHash,
          actions: scene.actions,
          targetDir: path.join(names.scenesDir, scene.id, 'artifacts'),
        });

        timingCurrent.set(scene.id, document !== null);
      }));
      const chains = sceneChains(project.scenes).filter((chain) => (
        chain.some((scene) => (
          !sceneFreshness(scene, inputs, lineageOf(scene.id)).clip
          || !timingCurrent.get(scene.id)
        ))
      ));
      const pending = chains.flat();

      if (pending.length === 0) {
        throw new ShowcaseError('nothing_to_record', 'Все клипы сцен уже свежие.', 409);
      }

      const screenOf = (scene: ShowcaseProject['scenes'][number]) => {
        const screens: ScreenMap[] = proof?.rehearsal.screens ?? internal.screens;
        // Найденный пробным проходом экран без его отчёта восстанавливается из адреса.
        const screen = screens.find((item) => item.id === scene.screenId)
          ?? screenFromPageId<ScreenMap & { title: string }>(scene.screenId);

        if (!screen) {
          throw new ShowcaseError(
            'unknown_screen',
            `Экран «${scene.screenId}» недоступен для этой цели.`,
            400,
          );
        }

        const index = [...project.scenes].sort((a, b) => a.order - b.order)
          .findIndex((item) => item.id === scene.id);

        // Найденные браузером элементы других экранов разрешаются так же, как в
        // пробном проходе: сцена, уводящая на другую страницу, ждёт элемент уже на ней.
        return {
          scene,
          screen: { ...screen, elements: resolvableElements(screens, screen) },
          observations: proof?.rehearsal.observations.filter((step) => step.sceneIndex === index),
        };
      };
      const taskChains = chains.map((chain) => chain.map(screenOf));
      const inputHashes = Object.fromEntries(
        pending.map((scene) => [scene.id, clipInputHash(scene, inputs, lineageOf(scene.id))]),
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
          chains: taskChains,
        },
        inheritedFds: lease ? [lease.inheritedFd()] : undefined,
      });

      attempts.set(record.id, handle);

      return toPublicJob(await jobs.progress(record.id, {
        sequence: record.sequence + 1,
        label: 'исполнитель записи запущен',
        total: pending.length,
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
    const published: {
      sceneId: string;
      artifact: ShowcaseArtifactRef;
      recordingTiming: ShowcaseDerivedArtifactRef | null;
    }[] = [];

    for (const scene of result.scenes) {
      const current = project.scenes.find((item) => item.id === scene.sceneId);

      if (!current) {
        continue;
      }

      const expected = job.inputHashes[scene.sceneId];
      const lineage = chainLineage(project.scenes, scene.sceneId);

      if (!expected || expected !== clipInputHash(current, inputs, lineage)) {
        continue;
      }

      const targetDir = path.join(names.scenesDir, scene.sceneId, 'artifacts');
      const artifact = await publishArtifact({
        file: scene.rawPath,
        kind: 'clip',
        inputHash: expected,
        producerVersion: PRODUCER_VERSIONS.recorder,
        durationMs: scene.durationMs,
        targetDir,
      });
      const recordingTiming = await publishRecordingTiming({
        timing: scene.recordingTiming,
        sceneInputHash: expected,
        clipContentHash: artifact.contentHash,
        actions: current.actions,
        targetDir,
      });

      published.push({ sceneId: scene.sceneId, artifact, recordingTiming });
    }

    if (published.length === 0) {
      return;
    }

    const saved = await store.updateProject(job.projectId, null, (current) => {
      // Хранилище намеренно помнит снимок цели при выборе, а readProject выше
      // подставляет её живую политику. После правки screens.json эти значения
      // различаются: проверять результат по старому снимку означало записать новые
      // clip/sidecar на диск и затем молча не прикрепить их к сцене.
      const currentInputs = inputsOf({ ...current, target: project.target });

      return {
        ...current,
        scenes: current.scenes.map((scene) => {
          const own = published.find((item) => item.sceneId === scene.id);
          const expected = job.inputHashes[scene.id];
          const lineage = chainLineage(current.scenes, scene.id);

          if (
            !own
            || !expected
            || own.artifact.inputHash !== expected
            || clipInputHash(scene, currentInputs, lineage) !== expected
          ) {
            return scene;
          }

          const actionsHash = syncActionsHash(scene.actions);
          const timingMatchesClip = own.recordingTiming === null
            || own.recordingTiming.inputHash === recordingTimingInputHash(
              expected,
              own.artifact.contentHash,
              actionsHash,
            );

          return timingMatchesClip
            ? {
              ...scene,
              clip: own.artifact,
              // Новый клип всегда заменяет пару clip+log. Невалидный результат
              // измерения не оставляет ссылку от предыдущей записи.
              recordingTiming: own.recordingTiming,
            }
            : scene;
        }),
      };
    });

    broadcast('showcase-changed', { projectId: job.projectId, revision: saved.revision });
  }

  return { publishRecording, startRecording };
}
