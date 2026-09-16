// Серверный координатор полного запуска ролика.
//
// Он не выполняет media-работу сам: каждый долгий шаг остаётся обычным ShowcaseJob,
// а BuildRun сохраняет порядок, снимок входов и решение о продолжении. Благодаря
// этому закрытие вкладки ничего не меняет, а перезапуск сервера продолжает журнал
// с последнего подтверждённого результата.
import { createHash } from 'node:crypto';

import {
  SHOWCASE_BUILD_REQUEST_ID_RE,
} from '../../../../shared/showcaseContracts.ts';
import type {
  ShowcaseBuildRun,
  ShowcaseBuildStage,
  ShowcaseBuildStopReason,
  ShowcaseJob,
  ShowcaseProject,
} from '../../../../shared/showcaseContracts.ts';
import type {
  BuildRunRecord,
  BuildRunSnapshot,
  ShowcaseBuildRuns,
} from './buildRuns.ts';
import { isBuildRunTerminal, toPublicBuildRun } from './buildRuns.ts';
import { revisionConflict, ShowcaseError } from './errors.ts';
import { isTerminal, toPublicJob } from './jobs.ts';
import type { JobRecord, ShowcaseJobs } from './jobs.ts';
import { sceneSyncBindingsState } from './scenes.ts';
import { MAX_REHEARSALS } from './script/verification.ts';

const BINDABLE_ACTIONS = new Set(['goto', 'click', 'hover', 'highlight', 'waitVisible', 'scroll']);
const REVIEW_ERRORS = new Set([
  'bad_sync_bindings',
  'stale_manual_bindings',
  'model_bindings_invalid',
  'invalid_bindings',
  'stale_bindings',
  'no_safe_pause',
  'no_stable_frame',
  'sync_conflict',
]);

export interface BuildOpsDeps {
  assertEnabled: () => void;
  buildRuns: ShowcaseBuildRuns;
  jobs: ShowcaseJobs;
  limits: () => { maxScenes: number; jobTimeoutMs?: number };
  readProject: (id: string) => Promise<ShowcaseProject>;
  analyze: (id: string) => Promise<ShowcaseProject>;
  prepareScript?: (id: string, onProgress?: (label: string) => Promise<void>) => Promise<ShowcaseProject>;
  scriptReady?: (project: ShowcaseProject) => Promise<boolean>;
  generateBindings: (id: string) => Promise<ShowcaseProject>;
  synthesizeScenes: (id: string) => Promise<ShowcaseJob>;
  startRecording: (id: string) => Promise<ShowcaseJob>;
  assemble: (id: string) => Promise<ShowcaseJob>;
  cancelJob: (id: string) => Promise<ShowcaseJob>;
  voiceReady: (project: ShowcaseProject) => Promise<boolean> | boolean;
  recordingReady: (project: ShowcaseProject) => Promise<boolean> | boolean;
  finalReady: (project: ShowcaseProject) => Promise<boolean> | boolean;
  validateFinal: (project: ShowcaseProject) => Promise<void> | void;
  restorePreviousFinal: (run: BuildRunRecord) => Promise<void> | void;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function targetSnapshot(project: ShowcaseProject) {
  if (project.target.status !== 'ready') {
    return { status: 'blocked', ref: project.ref };
  }

  const { scope } = project.target;

  return {
    status: 'ready',
    ref: project.ref,
    profile: scope.profile,
    targetFingerprint: scope.targetFingerprint,
    policyRevision: scope.policyRevision,
    dataRevision: scope.dataRevision,
    mapRevision: scope.mapRevision,
    environment: scope.environment,
    capabilities: [...scope.capabilities],
  };
}

function sceneSnapshot(
  project: ShowcaseProject,
  options: { bindings: boolean; voice: boolean },
) {
  return [...project.scenes]
    .sort((left, right) => left.order - right.order)
    .map((scene) => ({
      id: scene.id,
      order: scene.order,
      title: scene.title,
      screenId: scene.screenId,
      startState: scene.startState,
      readyCondition: scene.readyCondition,
      continuesPrevious: scene.continuesPrevious,
      actions: scene.actions,
      narration: scene.narration,
      caption: scene.caption,
      subtitleText: scene.subtitleText,
      direction: scene.direction,
      pronunciationOverrides: scene.pronunciationOverrides,
      syncBindings: options.bindings ? scene.syncBindings : null,
      audioSource: {
        ...scene.audioSource,
        voiceRef: options.voice || scene.audioSource.kind !== 'tts'
          ? scene.audioSource.voiceRef
          : null,
      },
    }));
}

/**
 * Содержательный снимок намеренно не включает revision, проверки и артефакты:
 * публикация WAV/клипа/финала двигает revision, но не является правкой человека.
 */
export function buildRunSnapshotOf(project: ShowcaseProject): BuildRunSnapshot {
  const target = targetSnapshot(project);
  const base = {
    schemaVersion: project.schemaVersion,
    ref: project.ref,
    target,
  };
  const scriptBaseHash = hash(base);
  const full = {
    ...base,
    brief: project.brief,
    scriptGaps: project.scriptGaps,
    scriptMapRevision: project.scriptMapRevision,
    scriptProofHash: project.scriptProofHash,
    scenes: sceneSnapshot(project, { bindings: true, voice: true }),
  };

  return {
    inputHash: hash(full),
    targetHash: hash(target),
    scriptBaseHash,
    withoutBindingsHash: hash({
      ...full,
      scenes: sceneSnapshot(project, { bindings: false, voice: true }),
    }),
    withoutVoiceHash: hash({
      ...full,
      scenes: sceneSnapshot(project, { bindings: true, voice: false }),
    }),
    sceneIds: [...project.scenes]
      .sort((left, right) => left.order - right.order)
      .map((scene) => scene.id),
  };
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof ShowcaseError) {
    return { code: error.code, message: error.message };
  }

  const source = error as { code?: unknown; message?: unknown } | null;

  if (typeof source?.code === 'string' && typeof source.message === 'string') {
    return { code: source.code, message: source.message };
  }

  return {
    code: 'build_failed',
    message: 'Внутренний сбой координатора сборки.',
  };
}

function stageKey(runId: string, stage: ShowcaseBuildStage, attempt: number): string {
  return `showcase-build:${runId}:${stage}:${attempt}`;
}

function currentChild(run: BuildRunRecord) {
  return [...run.children].reverse().find((child) => child.stage === run.stage) ?? null;
}

function bindingProblem(project: ShowcaseProject): ShowcaseBuildStopReason | null {
  for (const scene of project.scenes) {
    const state = sceneSyncBindingsState(scene);

    if (state.status === 'invalid' || state.status === 'stale') {
      return {
        code: state.status === 'stale' ? 'stale_bindings' : 'invalid_bindings',
        message: state.issues[0]?.message
          ?? `Смысловые привязки сцены «${scene.title}» требуют исправления.`,
      };
    }
  }

  return null;
}

function bindingsMissing(project: ShowcaseProject): boolean {
  return project.scenes.some((scene) => (
    scene.actions.some((action) => BINDABLE_ACTIONS.has(action.kind))
    && sceneSyncBindingsState(scene).status === 'missing'
  ));
}

/** Собственные изменения этапа допускаются узко; всё остальное — правка входов. */
function compatible(run: BuildRunRecord, next: BuildRunSnapshot): boolean {
  if (run.snapshot.inputHash === next.inputHash) {
    return true;
  }

  if (run.snapshot.targetHash !== next.targetHash) {
    return false;
  }

  if (run.stage === 'script-if-empty') {
    return run.snapshot.scriptBaseHash === next.scriptBaseHash;
  }

  if (run.stage === 'bindings') {
    return run.snapshot.withoutBindingsHash === next.withoutBindingsHash;
  }

  if (run.stage === 'voice-and-alignment') {
    return run.snapshot.withoutVoiceHash === next.withoutVoiceHash;
  }

  return false;
}

export function createBuildOps(deps: BuildOpsDeps) {
  const { buildRuns, jobs } = deps;
  const driving = new Map<string, Promise<void>>();

  /**
   * Модельный этап получает обычное job, но использует тот же analyze/bindings,
   * что и старые HTTP-ручки. Генерация не дублируется и остаётся model-only.
   */
  async function startTrackedModelJob(
    run: BuildRunRecord,
    attempt: number,
    operation: (id: string, onProgress?: (label: string) => Promise<void>) => Promise<ShowcaseProject>,
  ): Promise<JobRecord> {
    const key = stageKey(run.id, run.stage, attempt);
    const project = await deps.readProject(run.projectId);

    return jobs.withStageKey(key, async () => {
      const { record, reused } = await jobs.enqueue({
        projectId: run.projectId,
        kind: 'script',
        idempotencyKey: hash({
          kind: 'showcase-build-model',
          projectId: run.projectId,
          stage: run.stage,
          inputHash: run.snapshot.inputHash,
        }),
        inputHashes: { build: run.snapshot.inputHash },
        inputRevision: project.revision,
        timeoutMs: run.stage === 'script-if-empty'
          ? (deps.limits().jobTimeoutMs ?? 30 * 60_000) * MAX_REHEARSALS
          : undefined,
      });

      if (reused) {
        return record;
      }

      const running = await jobs.progress(record.id, {
        sequence: record.sequence + 1,
        label: run.stage === 'script-if-empty'
          ? 'сценарий проходит проверку на стенде'
          : 'модель готовит смысловые привязки',
      });

      const onProgress = async (label: string) => {
        const current = jobs.read(record.id);

        if (isTerminal(current.state) || current.state === 'cancelling') {
          throw new ShowcaseError('script_cancelled', 'Подготовка сценария отменена.', 409);
        }

        await jobs.progress(record.id, {
          sequence: current.sequence + 1,
          label,
        });
      };

      void operation(run.projectId, onProgress).then(async () => {
        await jobs.finish(record.id, {
          state: 'succeeded',
          label: run.stage === 'script-if-empty' ? 'сценарий готов' : 'привязки готовы',
        });
      }).catch(async (error) => {
        const details = errorDetails(error);

        await jobs.finish(record.id, {
          state: REVIEW_ERRORS.has(details.code) ? 'awaiting_review' : 'failed',
          error: details.message,
        });
      });

      return running;
    });
  }

  async function findOrStartChild(run: BuildRunRecord): Promise<JobRecord | null> {
    const attempt = run.children.filter((child) => child.stage === run.stage).length + 1;
    const key = stageKey(run.id, run.stage, attempt);
    const orphan = jobs.findByStageKey(key);

    if (orphan) {
      await buildRuns.attachChild(run.id, {
        stage: run.stage,
        jobId: orphan.id,
        attempt,
        stageKey: key,
        state: orphan.state,
      });

      return orphan;
    }

    let record: JobRecord;

    if (run.stage === 'script-if-empty') {
      record = await startTrackedModelJob(run, attempt, deps.prepareScript ?? deps.analyze);
    } else if (run.stage === 'bindings') {
      record = await startTrackedModelJob(run, attempt, deps.generateBindings);
    } else {
      const start = run.stage === 'voice-and-alignment'
        ? deps.synthesizeScenes
        : run.stage === 'record-if-needed'
          ? deps.startRecording
          : deps.assemble;
      const child = await jobs.withStageKey(key, () => start(run.projectId));

      record = jobs.read(child.id);
    }

    await buildRuns.attachChild(run.id, {
      stage: run.stage,
      jobId: record.id,
      attempt,
      stageKey: key,
      state: record.state,
    });

    return record;
  }

  async function stop(
    run: BuildRunRecord,
    state: 'awaiting_review' | 'failed' | 'interrupted' | 'cancelled',
    error: ShowcaseBuildStopReason | null,
  ): Promise<void> {
    const finished = await buildRuns.finish(run.id, state, error);

    if (
      state !== 'cancelled'
      && finished.state === 'cancelled'
      && finished.children.some((entry) => entry.stage === 'timeline-and-assemble')
    ) {
      await deps.restorePreviousFinal(finished);
    }
  }

  async function cancelChild(child: JobRecord | null): Promise<JobRecord | null> {
    if (!child || isTerminal(child.state)) {
      return child;
    }

    await deps.cancelJob(child.id);

    return jobs.read(child.id);
  }

  async function handleCancellation(run: BuildRunRecord, child: JobRecord | null): Promise<void> {
    const cancelled = await cancelChild(child);

    if (cancelled && !isTerminal(cancelled.state)) {
      await buildRuns.observeChild(run.id, cancelled.id, cancelled.state);

      return;
    }

    if (run.children.some((entry) => (
      entry.stage === 'timeline-and-assemble'
    ))) {
      await deps.restorePreviousFinal(run);
    }

    await stop(run, 'cancelled', null);
  }

  async function childOutcome(
    run: BuildRunRecord,
    child: JobRecord,
    project: ShowcaseProject,
  ): Promise<'continue' | 'retry' | 'stop'> {
    if (child.state === 'succeeded') {
      return 'continue';
    }

    if (child.state === 'awaiting_review') {
      await stop(run, 'awaiting_review', {
        code: 'child_awaiting_review',
        message: child.error ?? 'Этап требует решения человека.',
      });

      return 'stop';
    }

    if (child.state === 'failed') {
      await stop(run, 'failed', {
        code: 'child_failed',
        message: child.error ?? 'Дочерний этап завершился ошибкой.',
      });

      return 'stop';
    }

    if (child.state === 'cancelled') {
      await stop(run, 'cancelled', {
        code: 'child_cancelled',
        message: child.error ?? 'Дочерний этап был отменён.',
      });

      return 'stop';
    }

    if (child.state !== 'interrupted') {
      return 'stop';
    }

    const ready = run.stage === 'script-if-empty'
      ? project.scenes.length > 0 && (!deps.scriptReady || await deps.scriptReady(project))
      : run.stage === 'bindings'
        ? !bindingsMissing(project) && bindingProblem(project) === null
        : run.stage === 'voice-and-alignment'
          ? await deps.voiceReady(project)
          : run.stage === 'record-if-needed'
            ? await deps.recordingReady(project)
            : await deps.finalReady(project);

    if (ready) {
      return 'continue';
    }

    const safeRecordingRetry = run.stage === 'record-if-needed'
      && project.target.status === 'ready'
      && !project.target.scope.capabilities.includes('mutations');
    const safeRetry = run.stage === 'timeline-and-assemble' || safeRecordingRetry;

    const stageAttempts = run.children.filter((entry) => entry.stage === run.stage).length;

    if (safeRetry && stageAttempts < 2) {
      return 'retry';
    }

    await stop(run, 'interrupted', {
      code: 'child_interrupted',
      message: child.error
        ?? 'Исполнитель этапа исчез; автоматический повтор для него небезопасен.',
    });

    return 'stop';
  }

  async function nextStage(
    run: BuildRunRecord,
    stage: ShowcaseBuildStage,
    snapshot: BuildRunSnapshot,
  ): Promise<void> {
    await buildRuns.move(run.id, stage, snapshot);
  }

  async function runStage(
    run: BuildRunRecord,
    project: ShowcaseProject,
    snapshot: BuildRunSnapshot,
    child: JobRecord | null,
  ): Promise<'again' | 'wait' | 'done'> {
    if (run.stage === 'preflight') {
      if (project.target.status !== 'ready') {
        await stop(run, 'failed', { code: 'target_unavailable', message: project.target.reason });

        return 'done';
      }

      if (project.scenes.length > deps.limits().maxScenes) {
        await stop(run, 'failed', {
          code: 'scene_limit',
          message: `В ролике больше ${deps.limits().maxScenes} сцен.`,
        });

        return 'done';
      }

      await nextStage(run, 'script-if-empty', snapshot);

      return 'again';
    }

    if (run.stage === 'script-if-empty') {
      if (project.scenes.length > 0 && (!deps.scriptReady || await deps.scriptReady(project))) {
        await nextStage(run, 'bindings', snapshot);

        return 'again';
      }

      if (child?.state === 'succeeded' || child?.state === 'interrupted') {
        await stop(run, 'failed', {
          code: project.scenes.length > 0 ? 'script_not_verified' : 'script_empty',
          message: project.scenes.length > 0
            ? 'Проверка сценария завершилась без подтверждения показа на стенде.'
            : 'Разбор завершился без сцен.',
        });

        return 'done';
      }

      await findOrStartChild(run);

      return 'wait';
    }

    if (run.stage === 'bindings') {
      const problem = bindingProblem(project);

      if (problem) {
        await stop(run, 'awaiting_review', problem);

        return 'done';
      }

      if (!bindingsMissing(project)) {
        await nextStage(run, 'voice-and-alignment', snapshot);

        return 'again';
      }

      if (child?.state === 'succeeded' || child?.state === 'interrupted') {
        await stop(run, 'awaiting_review', {
          code: 'bindings_missing',
          message: 'Не для всех действий удалось подготовить однозначные привязки.',
        });

        return 'done';
      }

      await findOrStartChild(run);

      return 'wait';
    }

    if (run.stage === 'voice-and-alignment') {
      if (await deps.voiceReady(project)) {
        await nextStage(run, 'record-if-needed', snapshot);

        return 'again';
      }

      if (child?.state === 'succeeded' || child?.state === 'interrupted') {
        await stop(run, 'failed', {
          code: 'voice_artifacts_missing',
          message: 'Озвучка завершилась без свежего звука для всех сцен.',
        });

        return 'done';
      }

      await findOrStartChild(run);

      return 'wait';
    }

    if (run.stage === 'record-if-needed') {
      if (await deps.recordingReady(project)) {
        await nextStage(run, 'timeline-and-assemble', snapshot);

        return 'again';
      }

      if (child?.state === 'succeeded' || child?.state === 'interrupted') {
        await stop(run, 'failed', {
          code: 'recording_artifacts_missing',
          message: 'Запись завершилась без свежих клипов и измерений для всех сцен.',
        });

        return 'done';
      }

      await findOrStartChild(run);

      return 'wait';
    }

    if (run.stage === 'timeline-and-assemble') {
      if (await deps.finalReady(project)) {
        await nextStage(run, 'validate', snapshot);

        return 'again';
      }

      if (child?.state === 'succeeded' || child?.state === 'interrupted') {
        await stop(run, 'failed', {
          code: 'final_missing',
          message: 'Монтаж завершился без актуального итогового ролика.',
        });

        return 'done';
      }

      await findOrStartChild(run);

      return 'wait';
    }

    if (run.stage === 'validate') {
      try {
        await deps.validateFinal(project);
      } catch (error) {
        await stop(run, 'failed', errorDetails(error));

        return 'done';
      }

      const finished = await buildRuns.finish(run.id, 'succeeded', null);

      if (
        finished.state === 'cancelled'
        && finished.children.some((entry) => entry.stage === 'timeline-and-assemble')
      ) {
        await deps.restorePreviousFinal(finished);
      }

      return 'done';
    }

    return 'done';
  }

  /** Один проход всегда либо двигает stage, либо оставляет один ожидаемый child. */
  async function drive(id: string): Promise<void> {
    for (let step = 0; step < 16; step += 1) {
      let run = buildRuns.read(id);

      if (isBuildRunTerminal(run.state)) {
        return;
      }

      // Сначала подбирается child из crash-window создания: отмена тоже обязана
      // найти и снять его, а не оставить живым только из-за потерянной ссылки.
      if (!currentChild(run)) {
        const attempt = run.children.filter((entry) => entry.stage === run.stage).length + 1;
        const orphan = jobs.findByStageKey(stageKey(run.id, run.stage, attempt));

        if (orphan) {
          run = await buildRuns.attachChild(run.id, {
            stage: run.stage,
            jobId: orphan.id,
            attempt,
            stageKey: stageKey(run.id, run.stage, attempt),
            state: orphan.state,
          });
        }
      }

      const childRef = currentChild(run);
      let child: JobRecord | null = null;

      if (childRef) {
        try {
          child = jobs.read(childRef.jobId);
        } catch {
          await stop(run, 'interrupted', {
            code: 'child_missing',
            message: 'Ссылка запуска указывает на отсутствующее дочернее задание.',
          });

          return;
        }

        if (child.state !== childRef.state) {
          run = await buildRuns.observeChild(run.id, child.id, child.state);
        }
      }

      if (run.cancelRequested) {
        await handleCancellation(run, child);

        return;
      }

      let project: ShowcaseProject;

      try {
        project = await deps.readProject(run.projectId);
      } catch (error) {
        await stop(run, 'failed', errorDetails(error));

        return;
      }

      const snapshot = buildRunSnapshotOf(project);

      if (!compatible(run, snapshot)) {
        await cancelChild(child);
        await stop(run, 'failed', {
          code: 'build_inputs_changed',
          message: 'Содержательные входы или поколение цели изменились во время сборки.',
        });

        return;
      }

      if (child && !isTerminal(child.state)) {
        return;
      }

      if (child) {
        const outcome = await childOutcome(run, child, project);

        if (outcome === 'stop') {
          return;
        }

        if (outcome === 'retry') {
          try {
            await findOrStartChild(run);
          } catch (error) {
            const details = errorDetails(error);

            if (details.code !== 'queue_full') {
              await stop(run, REVIEW_ERRORS.has(details.code) ? 'awaiting_review' : 'failed', details);
            }
          }

          return;
        }
      }

      try {
        const result = await runStage(run, project, snapshot, child);

        if (result !== 'again') {
          return;
        }
      } catch (error) {
        const details = errorDetails(error);

        // Ручное job могло занять единственное место. BuildRun его не вытесняет
        // и не падает: следующий poll повторит постановку после освобождения.
        if (details.code === 'queue_full') {
          return;
        }

        if (
          (details.code === 'nothing_to_synthesize' && await deps.voiceReady(project))
          || (details.code === 'nothing_to_record' && await deps.recordingReady(project))
        ) {
          const next = run.stage === 'voice-and-alignment'
            ? 'record-if-needed'
            : 'timeline-and-assemble';

          await nextStage(run, next, snapshot);

          continue;
        }

        await stop(run, REVIEW_ERRORS.has(details.code) ? 'awaiting_review' : 'failed', details);

        return;
      }
    }

    await buildRuns.finish(id, 'failed', {
      code: 'build_transition_loop',
      message: 'Координатор превысил предел переходов без ожидаемого этапа.',
    });
  }

  function schedule(id: string): Promise<void> {
    const existing = driving.get(id);

    if (existing) {
      return existing;
    }

    const task = drive(id).catch(async (error) => {
      const run = buildRuns.read(id);

      if (!isBuildRunTerminal(run.state)) {
        await buildRuns.finish(id, 'failed', errorDetails(error));
      }
    }).finally(() => {
      driving.delete(id);
    });

    driving.set(id, task);

    return task;
  }

  /** POST сохраняет запуск до ответа; выполнение после этого принадлежит серверу. */
  async function startBuild(
    projectId: string,
    revision: number,
    requestId: string,
  ): Promise<ShowcaseBuildRun> {
    deps.assertEnabled();

    if (!SHOWCASE_BUILD_REQUEST_ID_RE.test(requestId)) {
      throw new ShowcaseError('bad_request_id', 'Некорректный requestId запуска.', 400);
    }

    const requested = buildRuns.findByRequestId(requestId);

    if (requested) {
      if (requested.projectId !== projectId || requested.initialRevision !== revision) {
        throw new ShowcaseError(
          'build_request_conflict',
          'Этот requestId уже использован для других входов сборки.',
          409,
        );
      }

      // Ревизия файла проекта не меняется, когда внешний resolver увидел новый
      // generation/lease той же цели. Поэтому повтор requestId тоже сверяет
      // фактический содержательный снимок, а не доверяет одной паре id/revision.
      const current = await deps.readProject(projectId);
      const snapshot = buildRunSnapshotOf(current);

      if (!compatible(requested, snapshot)) {
        throw new ShowcaseError(
          'build_request_conflict',
          'Этот requestId уже использован для других входов сборки.',
          409,
        );
      }

      return toPublicBuildRun(requested);
    }

    const project = await deps.readProject(projectId);

    if (project.revision !== revision) {
      throw revisionConflict(project.revision);
    }

    const snapshot = buildRunSnapshotOf(project);
    const { record, reused } = await buildRuns.create({
      projectId,
      initialRevision: revision,
      requestId,
      requestInputHash: snapshot.inputHash,
      snapshot,
      previousFinal: project.latestFinal,
    });

    if (!reused) {
      void schedule(record.id);
    }

    return toPublicBuildRun(record);
  }

  function readBuild(id: string): ShowcaseBuildRun {
    deps.assertEnabled();

    return toPublicBuildRun(buildRuns.read(id));
  }

  async function cancelBuild(id: string): Promise<ShowcaseBuildRun> {
    deps.assertEnabled();

    const run = await buildRuns.requestCancel(id);

    // Запрос мог попасть в короткое окно, когда уже запущенный drive прошёл
    // проверку отмены. После его завершения нужен ещё один проход; если первый
    // уже увидел отмену, повтор только подтвердит ожидающий cancelling child.
    void schedule(run.id).then(async () => {
      const current = buildRuns.read(run.id);

      if (current.cancelRequested && !isBuildRunTerminal(current.state)) {
        await schedule(run.id);
      }
    }).catch(() => undefined);

    return toPublicBuildRun(run);
  }

  /** Опрос двигает все run после того, как service опубликовал результаты jobs. */
  async function poll(): Promise<void> {
    await Promise.all(buildRuns.active().map((run) => schedule(run.id)));
    await buildRuns.sweep();
  }

  async function recover(): Promise<{ active: number; corrupted: number }> {
    const result = await buildRuns.recover();

    await poll();

    return result;
  }

  async function cancelActive(): Promise<void> {
    for (const run of buildRuns.active()) {
      await buildRuns.requestCancel(run.id);
      await schedule(run.id);

      const current = buildRuns.read(run.id);

      if (current.cancelRequested && !isBuildRunTerminal(current.state)) {
        await schedule(run.id);
      }
    }
  }

  return {
    cancelActive,
    cancelBuild,
    poll,
    readBuild,
    recover,
    startBuild,
  };
}

export type ShowcaseBuildOps = ReturnType<typeof createBuildOps>;
