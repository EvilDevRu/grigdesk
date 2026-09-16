// Полный серверный запуск ролика: сохранение, переходы, повторы и восстановление.
//
// Все стадии поддельные и детерминированные: тест не обращается к модели, голосу,
// браузеру или ffmpeg, но использует настоящий журнал jobs и BuildRun.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBuildOps, buildRunSnapshotOf } from '../../server/src/lib/showcase/buildOps.ts';
import {
  createShowcaseBuildRuns,
  toPublicBuildRun,
} from '../../server/src/lib/showcase/buildRuns.ts';
import { ShowcaseError } from '../../server/src/lib/showcase/errors.ts';
import { createShowcaseJobs, toPublicJob } from '../../server/src/lib/showcase/jobs.ts';
import { createSyncBindings } from '../../server/src/lib/showcase/scenes.ts';
import { parseShowcaseBuildRun } from '../../shared/showcaseContracts.ts';

const PROJECT_ID = '0123456789abcdef';
const REQUEST_ID = 'build-request-0001';

function target() {
  return {
    status: 'ready',
    ref: { kind: 'project', id: 'demo-profile' },
    scope: {
      targetKind: 'project',
      targetLabel: 'demo-profile',
      profile: 'demo-profile',
      viewUrl: 'http://127.0.0.1:5173',
      environment: 'read-only',
      capabilities: ['record'],
      screens: [{ id: 'overview', title: 'Обзор', path: '/' }],
      targetFingerprint: 'target-v1',
      policyRevision: 'policy-v1',
      mapRevision: 'map-v1',
      dataRevision: 'data-v1',
      buildRevision: null,
    },
  };
}

function scene({ bindings = true } = {}) {
  const actions = [{ kind: 'click', targetId: 'run' }];

  return {
    id: 'scene-0000000001',
    order: 1,
    title: 'Запуск',
    screenId: 'overview',
    startState: null,
    readyCondition: null,
    continuesPrevious: false,
    actions,
    narration: 'Показываю запуск.',
    caption: 'Запуск',
    subtitleText: 'Показываю запуск.',
    direction: { tone: null, pace: null, emphasis: [], pauses: [], stresses: [] },
    timing: null,
    syncBindings: bindings
      ? createSyncBindings('Показываю запуск.', actions, [{
        actionIndex: 0,
        from: 10,
        to: 16,
        kind: 'align-start',
        origin: 'generated',
      }])
      : null,
    speechTiming: null,
    speechAlignment: null,
    recordingTiming: null,
    audioSource: { kind: 'tts', voiceRef: 'edge:voice', artifactId: null },
    audio: null,
    clip: null,
    frame: null,
    checks: [],
    stale: true,
  };
}

function project({ empty = false, bindings = true } = {}) {
  const now = new Date().toISOString();

  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    title: 'Ролик',
    revision: 1,
    ref: { kind: 'project', id: 'demo-profile' },
    target: target(),
    brief: empty ? [] : ['Показать запуск'],
    scenes: empty ? [] : [scene({ bindings })],
    scriptGaps: [],
    scriptMapRevision: empty ? null : 'map-v1',
    decisions: [],
    latestFinal: null,
    createdAt: now,
    updatedAt: now,
  };
}

// Ожидание ограничено временем, а не числом проходов event loop: запись журнала
// заданий идёт через диск, и под параллельным прогоном сорока файлов сто проходов
// пролетали раньше, чем возвращалась запись.
async function waitUntil(check) {
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    if (check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.fail('Условие не наступило за 3 с.');
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-build-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const events = [];
  const jobs = createShowcaseJobs({
    jobsDir: path.join(root, 'jobs'),
    broadcast: (name, data) => events.push([name, data]),
    limits: () => ({ maxQueued: options.maxQueued ?? 1, jobTimeoutMs: 60_000 }),
  });
  const buildRuns = createShowcaseBuildRuns({
    runsDir: path.join(root, 'builds'),
    broadcast: (name, data) => events.push([name, data]),
    limits: () => ({ retentionDays: 30, maxRuns: options.maxRuns ?? 50 }),
  });

  await jobs.recover();
  await buildRuns.recover();

  let current = options.project ?? project();
  const ready = { voice: false, recording: false, final: false };
  const calls = [];
  const childIds = new Map();
  let jobSerial = 0;
  let restores = 0;
  let validations = 0;

  async function startChild(kind) {
    calls.push(kind);
    jobSerial += 1;

    const { record } = await jobs.enqueue({
      projectId: PROJECT_ID,
      kind,
      idempotencyKey: `${kind}-${jobSerial}`,
      inputHashes: { [kind]: `hash-${jobSerial}` },
      inputRevision: current.revision,
    });
    const running = await jobs.progress(record.id, {
      sequence: record.sequence + 1,
      label: `${kind} выполняется`,
    });

    childIds.set(kind, running.id);

    return toPublicJob(running);
  }

  const ops = createBuildOps({
    assertEnabled: () => {},
    buildRuns,
    jobs,
    limits: () => ({ maxScenes: 20 }),
    readProject: async () => current,
    scriptReady: options.scriptReady,
    prepareScript: options.prepareScript ? async (_id, onProgress) => {
      calls.push('prepare');
      current = await options.prepareScript(current, onProgress);

      return current;
    } : undefined,
    analyze: async () => {
      calls.push('analyze');
      current = {
        ...current,
        revision: current.revision + 1,
        brief: ['Показать запуск'],
        scenes: [scene({ bindings: false })],
        scriptMapRevision: 'map-v1',
      };

      return current;
    },
    generateBindings: async () => {
      calls.push('bindings');
      current = {
        ...current,
        revision: current.revision + 1,
        scenes: current.scenes.map(() => scene({ bindings: true })),
      };

      return current;
    },
    synthesizeScenes: options.synthesizeScenes ?? (() => startChild('voice')),
    startRecording: options.startRecording ?? (() => startChild('record')),
    assemble: options.assemble ?? (() => startChild('assemble')),
    cancelJob: async (id) => toPublicJob(await jobs.cancel(id)),
    voiceReady: () => ready.voice,
    recordingReady: () => ready.recording,
    finalReady: () => ready.final,
    validateFinal: async (value) => {
      validations += 1;

      await options.validateFinal?.(value);
    },
    restorePreviousFinal: () => {
      restores += 1;
    },
  });

  async function finish(kind, state = 'succeeded', error = null) {
    if (state === 'succeeded') {
      if (kind === 'voice') ready.voice = true;
      if (kind === 'record') ready.recording = true;
      if (kind === 'assemble') ready.final = true;
    }

    const id = childIds.get(kind);

    assert.ok(id, `дочернее задание ${kind} должно существовать`);
    await jobs.finish(id, { state, error });
  }

  return {
    buildRuns,
    calls,
    childIds,
    events,
    finish,
    get project() {
      return current;
    },
    jobs,
    ops,
    ready,
    root,
    setProject(next) {
      current = next;
    },
    stats() {
      return { restores, validations };
    },
  };
}

test('старый сценарий автоматически проверяется до первой озвучки', async (t) => {
  const item = await fixture(t, {
    scriptReady: async (project) => Boolean(project.scriptProofHash),
    prepareScript: async (project) => ({
      ...project,
      scriptProofHash: 'proof',
      revision: project.revision + 1,
    }),
  });

  await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);
  await item.ops.poll();
  await waitUntil(() => item.jobs.list().some((job) => job.kind === 'script' && job.state === 'succeeded'));
  await item.ops.poll();
  await waitUntil(() => item.calls.includes('voice'));

  assert.deepEqual(item.calls.slice(0, 2), ['prepare', 'voice']);
  assert.equal(item.project.scriptProofHash, 'proof');
});

test('непройденная проверка старого сценария не запускает озвучку и запись', async (t) => {
  const item = await fixture(t, {
    scriptReady: async () => false,
    prepareScript: async () => {
      throw new ShowcaseError('script_not_verified', 'Открылось другое окно.', 409);
    },
  });

  const run = await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);

  await item.ops.poll();
  await waitUntil(() => item.jobs.list().some((job) => job.kind === 'script' && job.state === 'failed'));
  await item.ops.poll();

  await waitUntil(() => item.ops.readBuild(run.id).state === 'failed');
  assert.deepEqual(item.calls, ['prepare']);
});

test('проверка сценария публикует смену проходов через обычный прогресс задания', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const item = await fixture(t, {
    scriptReady: async (project) => Boolean(project.scriptProofHash),
    prepareScript: async (project, onProgress) => {
      await onProgress('Проверяю действия на стенде: проход 1 из 6.');
      await gate;
      await onProgress('Сверяю рассказ с кадрами: проход 1 из 6.');

      return {
        ...project,
        scriptProofHash: 'proof',
        revision: project.revision + 1,
      };
    },
  });

  await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);
  await item.ops.poll();
  await waitUntil(() => item.jobs.list().some((job) => /Проверяю действия/.test(job.progress.label)));
  const progress = item.jobs.list().find((job) => job.kind === 'script');

  assert.equal(progress.state, 'running');
  assert.match(progress.progress.label, /проход 1 из 6/);
  release();
  await waitUntil(() => item.jobs.read(progress.id).state === 'succeeded');
  assert.ok(item.jobs.read(progress.id).sequence > progress.sequence);
});

test('один BuildRun проходит все этапы и не занимает очередь maxQueued=1', async (t) => {
  const item = await fixture(t, { project: project({ empty: true }), maxQueued: 1 });
  const accepted = await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);

  assert.equal(accepted.state, 'queued', 'ответ возвращает уже сохранённый запуск');
  await item.ops.poll();
  await waitUntil(() => item.jobs.list().filter((job) => job.kind === 'script').length === 1
    && item.jobs.list().every((job) => job.state === 'succeeded'));
  await item.ops.poll();
  await waitUntil(() => item.jobs.list().filter((job) => job.kind === 'script').length === 2
    && item.jobs.list().filter((job) => job.kind === 'script').every((job) => (
      job.state === 'succeeded'
    )));
  await item.ops.poll();

  assert.equal(item.jobs.active().length, 1);
  assert.equal(item.jobs.active()[0].kind, 'voice');

  await item.finish('voice');
  await item.ops.poll();
  assert.equal(item.jobs.active().length, 1);
  assert.equal(item.jobs.active()[0].kind, 'record');

  await item.finish('record');
  await item.ops.poll();
  assert.equal(item.jobs.active().length, 1);
  assert.equal(item.jobs.active()[0].kind, 'assemble');

  await item.finish('assemble');
  await item.ops.poll();

  const completed = item.buildRuns.read(accepted.id);

  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.stage, 'done');
  assert.deepEqual(
    completed.children.map((child) => child.stage),
    [
      'script-if-empty',
      'bindings',
      'voice-and-alignment',
      'record-if-needed',
      'timeline-and-assemble',
    ],
  );
  assert.deepEqual(item.calls, ['analyze', 'bindings', 'voice', 'record', 'assemble']);
  assert.equal(item.stats().validations, 1);
  assert.equal(item.jobs.active().length, 0);
});

test('requestId идемпотентен, а второй клиент присоединяется к тем же входам', async (t) => {
  const item = await fixture(t);
  const [first, repeated] = await Promise.all([
    item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID),
    item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID),
  ]);
  const joined = await item.ops.startBuild(PROJECT_ID, 1, 'build-request-0002');

  assert.equal(repeated.id, first.id);
  assert.equal(joined.id, first.id);
  assert.equal(item.buildRuns.list().length, 1);
  assert.deepEqual(
    item.buildRuns.read(first.id).requestIds,
    [REQUEST_ID, 'build-request-0002'],
  );

  await assert.rejects(
    () => item.ops.startBuild(PROJECT_ID, 2, REQUEST_ID),
    (error) => error.code === 'build_request_conflict' && error.status === 409,
  );

  item.setProject({ ...item.project, revision: 2, title: 'Не влияет' });
  const sameContent = await item.ops.startBuild(PROJECT_ID, 2, 'build-request-0003');

  assert.equal(sameContent.id, first.id, 'служебная revision не создаёт второй run');

  item.setProject({
    ...item.project,
    revision: 3,
    scenes: item.project.scenes.map((entry) => ({ ...entry, narration: 'Другой текст.' })),
  });

  await assert.rejects(
    () => item.ops.startBuild(PROJECT_ID, 3, 'build-request-0004'),
    (error) => error.code === 'build_already_running' && error.status === 409,
  );

  const generation = await fixture(t);

  await generation.ops.startBuild(PROJECT_ID, 1, 'build-request-generation');
  await generation.ops.poll();
  generation.setProject({
    ...generation.project,
    target: {
      ...generation.project.target,
      scope: { ...generation.project.target.scope, targetFingerprint: 'target-v2' },
    },
  });

  await assert.rejects(
    () => generation.ops.startBuild(PROJECT_ID, 1, 'build-request-generation'),
    (error) => error.code === 'build_request_conflict' && error.status === 409,
  );
});

test('child из окна сбоя находится по устойчивому ключу и не запускается второй раз', async (t) => {
  const item = await fixture(t);
  const snapshot = buildRunSnapshotOf(item.project);
  const created = await item.buildRuns.create({
    projectId: PROJECT_ID,
    initialRevision: 1,
    requestId: REQUEST_ID,
    requestInputHash: snapshot.inputHash,
    snapshot,
    previousFinal: null,
  });

  await item.buildRuns.move(created.record.id, 'voice-and-alignment', snapshot);

  const key = `showcase-build:${created.record.id}:voice-and-alignment:1`;
  const orphan = await item.jobs.withStageKey(key, async () => {
    const { record } = await item.jobs.enqueue({
      projectId: PROJECT_ID,
      kind: 'voice',
      idempotencyKey: 'orphan-voice',
      inputHashes: { voice: 'hash' },
      inputRevision: 1,
    });

    return item.jobs.progress(record.id, { sequence: 2, label: 'озвучиваем' });
  });

  await item.ops.poll();

  const recovered = item.buildRuns.read(created.record.id);

  assert.equal(recovered.children.length, 1);
  assert.equal(recovered.children[0].jobId, orphan.id);
  assert.deepEqual(item.calls, [], 'второй provider request не появился');
});

test('отмена сохраняется раньше child cancellation и не запускает следующий этап', async (t) => {
  const item = await fixture(t);
  const run = await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);

  await item.ops.poll();

  const voiceId = item.jobs.active()[0].id;
  const requested = await item.ops.cancelBuild(run.id);

  assert.equal(requested.state, 'cancelling');
  assert.equal(requested.cancelRequested, true);
  await item.ops.poll();
  assert.equal(item.jobs.read(voiceId).state, 'cancelling');

  await item.jobs.finish(voiceId, { state: 'succeeded', label: 'поздний успех' });
  assert.equal(item.jobs.read(voiceId).state, 'cancelled');
  await item.ops.poll();

  assert.equal(item.buildRuns.read(run.id).state, 'cancelled');
  assert.equal(item.calls.includes('record'), false);

  const sequences = item.events
    .filter(([name]) => name === 'showcase-build-progress')
    .map(([, event]) => event.sequence);

  assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
  assert.equal(new Set(sequences).size, sequences.length);
});

test('отмена на границе assemble возвращает предыдущий финал после позднего успеха', async (t) => {
  const item = await fixture(t);
  const run = await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);

  await item.ops.poll();
  await item.finish('voice');
  await item.ops.poll();
  await item.finish('record');
  await item.ops.poll();

  const assembleId = item.childIds.get('assemble');

  assert.ok(assembleId);
  await item.ops.cancelBuild(run.id);
  await item.ops.poll();
  assert.equal(item.jobs.read(assembleId).state, 'cancelling');

  // Имитируем уже опубликованный результат: сохранённая отмена сильнее позднего
  // success, а coordinator обязан вызвать атомарное восстановление старой ссылки.
  item.ready.final = true;
  await item.jobs.finish(assembleId, { state: 'succeeded', label: 'поздний монтаж' });
  await item.ops.poll();

  assert.equal(item.buildRuns.read(run.id).state, 'cancelled');
  assert.equal(item.stats().restores, 1);
  assert.equal(item.stats().validations, 0);

  const validation = await fixture(t);
  const snapshot = buildRunSnapshotOf(validation.project);
  const created = await validation.buildRuns.create({
    projectId: PROJECT_ID,
    initialRevision: 1,
    requestId: 'build-request-validation',
    requestInputHash: snapshot.inputHash,
    snapshot,
    previousFinal: null,
  });
  const { record: assembly } = await validation.jobs.enqueue({
    projectId: PROJECT_ID,
    kind: 'assemble',
    idempotencyKey: 'assembly-before-validate',
    inputHashes: { final: 'published-final' },
    inputRevision: 1,
  });

  await validation.jobs.finish(assembly.id, { state: 'succeeded' });
  await validation.buildRuns.move(created.record.id, 'timeline-and-assemble', snapshot);
  await validation.buildRuns.attachChild(created.record.id, {
    stage: 'timeline-and-assemble',
    jobId: assembly.id,
    attempt: 1,
    stageKey: 'build-validation-assemble',
    state: 'succeeded',
  });
  await validation.buildRuns.move(created.record.id, 'validate', snapshot);
  await validation.buildRuns.requestCancel(created.record.id);
  await validation.ops.poll();

  assert.equal(validation.buildRuns.read(created.record.id).state, 'cancelled');
  assert.equal(validation.stats().restores, 1, 'validate тоже остаётся границей публикации');
});

test('отмена во время validate сильнее позднего успешного завершения run', async (t) => {
  let enterValidation;
  let releaseValidation;
  const entered = new Promise((resolve) => {
    enterValidation = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  const item = await fixture(t, {
    validateFinal: async () => {
      enterValidation();
      await blocked;
    },
  });
  const run = await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);

  await item.ops.poll();
  await item.finish('voice');
  await item.ops.poll();
  await item.finish('record');
  await item.ops.poll();
  await item.finish('assemble');

  const validation = item.ops.poll();

  await entered;
  const cancelling = await item.ops.cancelBuild(run.id);

  assert.equal(cancelling.state, 'cancelling');
  releaseValidation();
  await validation;
  await item.ops.poll();

  assert.equal(item.buildRuns.read(run.id).state, 'cancelled');
  assert.equal(item.stats().restores, 1);
});

test('изменение текста или generation останавливает run и снимает child', async (t) => {
  const item = await fixture(t);
  const run = await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);

  await item.ops.poll();
  item.setProject({
    ...item.project,
    revision: 2,
    scenes: item.project.scenes.map((entry) => ({ ...entry, narration: 'Текст изменён.' })),
  });
  await item.ops.poll();

  const changed = item.buildRuns.read(run.id);

  assert.equal(changed.state, 'failed');
  assert.equal(changed.error.code, 'build_inputs_changed');
  assert.equal(item.calls.includes('record'), false);

  const generation = await fixture(t);
  const second = await generation.ops.startBuild(PROJECT_ID, 1, 'build-request-1000');

  await generation.ops.poll();
  generation.setProject({
    ...generation.project,
    revision: 2,
    target: {
      ...generation.project.target,
      scope: { ...generation.project.target.scope, targetFingerprint: 'target-v2' },
    },
  });
  await generation.ops.poll();

  assert.equal(generation.buildRuns.read(second.id).error.code, 'build_inputs_changed');
});

test('nothing_to_* считается пропуском только после проверки свежего результата', async (t) => {
  const item = await fixture(t, {
    synthesizeScenes: async () => {
      throw new ShowcaseError('nothing_to_synthesize', 'Озвучивать нечего.', 409);
    },
  });
  const run = await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);

  await item.ops.poll();

  assert.equal(item.buildRuns.read(run.id).state, 'failed');
  assert.equal(item.buildRuns.read(run.id).error.code, 'nothing_to_synthesize');
});

test('BuildRun не маскирует stale bindings и awaiting_review терминален', async (t) => {
  const staleProject = project();

  staleProject.scenes[0] = {
    ...staleProject.scenes[0],
    narration: 'Текст уже изменился.',
  };

  const item = await fixture(t, { project: staleProject });
  const run = await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);

  await item.ops.poll();

  const stopped = item.buildRuns.read(run.id);

  assert.equal(stopped.state, 'awaiting_review');
  assert.equal(stopped.error.code, 'stale_bindings');
  assert.equal(item.jobs.list().length, 0);
});

test('очередь чужого job не блокируется родителем и освобождение запускает child', async (t) => {
  const item = await fixture(t, { maxQueued: 1 });
  const { record: manual } = await item.jobs.enqueue({
    projectId: 'fedcba9876543210',
    kind: 'record',
    idempotencyKey: 'manual-job',
    inputHashes: { clip: 'other' },
    inputRevision: 1,
  });
  const run = await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);

  await item.ops.poll();
  assert.equal(item.buildRuns.read(run.id).stage, 'voice-and-alignment');
  assert.equal(item.buildRuns.read(run.id).children.length, 0);
  assert.equal(item.jobs.active().length, 1, 'BuildRun не занял второе место');

  await item.jobs.finish(manual.id, { state: 'succeeded' });
  await item.ops.poll();

  assert.equal(item.buildRuns.read(run.id).children.length, 1);
  assert.equal(item.jobs.active()[0].kind, 'voice');
});

test('прерванная запись повторяется один раз новым job, голос автоматически не повторяется', async (t) => {
  const item = await fixture(t);
  const run = await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);

  await item.ops.poll();
  await item.finish('voice');
  await item.ops.poll();

  const firstRecord = item.childIds.get('record');

  await item.jobs.finish(firstRecord, { state: 'interrupted', error: 'worker исчез' });
  await item.ops.poll();

  const recordChildren = item.buildRuns.read(run.id).children.filter((child) => (
    child.stage === 'record-if-needed'
  ));

  assert.equal(recordChildren.length, 2);
  assert.notEqual(recordChildren[0].jobId, recordChildren[1].jobId);
  assert.equal(recordChildren[1].attempt, 2);

  const voice = await fixture(t);
  const voiceRun = await voice.ops.startBuild(PROJECT_ID, 1, 'build-request-voice');

  await voice.ops.poll();
  await voice.jobs.finish(voice.childIds.get('voice'), {
    state: 'interrupted',
    error: 'ответ поставщика неизвестен',
  });
  await voice.ops.poll();

  assert.equal(voice.buildRuns.read(voiceRun.id).state, 'interrupted');
  assert.equal(voice.calls.filter((call) => call === 'voice').length, 1);
});

test('после холодного старта BuildRun подхватывает live child и повторяет dead record', async (t) => {
  const live = await fixture(t);
  const liveRun = await live.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);

  await live.ops.poll();
  await live.finish('voice');
  await live.ops.poll();

  const liveRecordId = live.childIds.get('record');
  const identity = await import('../../server/src/lib/speech/modelJobsProcess.ts')
    .then((module) => module.readProcessIdentity(process.pid));

  await live.jobs.progress(liveRecordId, {
    sequence: live.jobs.read(liveRecordId).sequence + 1,
    identity,
    label: 'живой recorder',
  });

  const freshLiveJobs = createShowcaseJobs({
    jobsDir: path.join(live.root, 'jobs'),
    broadcast: () => {},
    limits: () => ({ maxQueued: 1, jobTimeoutMs: 60_000 }),
  });
  const freshLiveRuns = createShowcaseBuildRuns({
    runsDir: path.join(live.root, 'builds'),
    broadcast: () => {},
    limits: () => ({ retentionDays: 30, maxRuns: 50 }),
  });
  let unexpectedStarts = 0;
  const freshLiveOps = createBuildOps({
    assertEnabled: () => {},
    buildRuns: freshLiveRuns,
    jobs: freshLiveJobs,
    limits: () => ({ maxScenes: 20 }),
    readProject: async () => live.project,
    analyze: async () => live.project,
    generateBindings: async () => live.project,
    synthesizeScenes: async () => {
      unexpectedStarts += 1;
      throw new Error('voice не должен запускаться');
    },
    startRecording: async () => {
      unexpectedStarts += 1;
      throw new Error('record не должен запускаться');
    },
    assemble: async () => {
      unexpectedStarts += 1;
      throw new Error('assemble не должен запускаться');
    },
    cancelJob: async (id) => toPublicJob(await freshLiveJobs.cancel(id)),
    voiceReady: () => true,
    recordingReady: () => false,
    finalReady: () => false,
    validateFinal: () => {},
    restorePreviousFinal: () => {},
  });

  const liveRecovery = await freshLiveJobs.recover();

  assert.equal(liveRecovery.alive, 1);
  await freshLiveOps.recover();
  assert.equal(freshLiveRuns.read(liveRun.id).children.length, 2);
  assert.equal(
    freshLiveRuns.read(liveRun.id).children.filter((child) => (
      child.stage === 'record-if-needed'
    )).length,
    1,
  );
  assert.equal(unexpectedStarts, 0);

  const dead = await fixture(t);
  const deadRun = await dead.ops.startBuild(PROJECT_ID, 1, 'build-request-dead');

  await dead.ops.poll();
  await dead.finish('voice');
  await dead.ops.poll();

  const deadRecordId = dead.childIds.get('record');
  const deadJobFile = path.join(dead.root, 'jobs', deadRecordId, 'job.json');
  const deadJob = JSON.parse(await readFile(deadJobFile, 'utf8'));

  await writeFile(deadJobFile, JSON.stringify({
    ...deadJob,
    state: 'running',
    heartbeatAt: new Date().toISOString(),
    identity: { pid: 999_999, starttime: '111', cmdline: 'showcaseWorker' },
  }), 'utf8');

  const freshDeadJobs = createShowcaseJobs({
    jobsDir: path.join(dead.root, 'jobs'),
    broadcast: () => {},
    limits: () => ({ maxQueued: 1, jobTimeoutMs: 60_000 }),
  });
  const freshDeadRuns = createShowcaseBuildRuns({
    runsDir: path.join(dead.root, 'builds'),
    broadcast: () => {},
    limits: () => ({ retentionDays: 30, maxRuns: 50 }),
  });
  let recoveredRecordId = null;
  const freshDeadOps = createBuildOps({
    assertEnabled: () => {},
    buildRuns: freshDeadRuns,
    jobs: freshDeadJobs,
    limits: () => ({ maxScenes: 20 }),
    readProject: async () => dead.project,
    analyze: async () => dead.project,
    generateBindings: async () => dead.project,
    synthesizeScenes: async () => {
      throw new Error('voice не должен запускаться');
    },
    startRecording: async () => {
      const { record } = await freshDeadJobs.enqueue({
        projectId: PROJECT_ID,
        kind: 'record',
        idempotencyKey: 'record-after-recovery',
        inputHashes: { clip: 'record-after-recovery' },
        inputRevision: dead.project.revision,
      });
      const running = await freshDeadJobs.progress(record.id, {
        sequence: record.sequence + 1,
        label: 'повтор записи',
      });

      recoveredRecordId = running.id;

      return toPublicJob(running);
    },
    assemble: async () => {
      throw new Error('assemble не должен запускаться');
    },
    cancelJob: async (id) => toPublicJob(await freshDeadJobs.cancel(id)),
    voiceReady: () => true,
    recordingReady: () => false,
    finalReady: () => false,
    validateFinal: () => {},
    restorePreviousFinal: () => {},
  });

  const deadRecovery = await freshDeadJobs.recover();

  assert.equal(deadRecovery.interrupted, 1);
  await freshDeadOps.recover();

  const recordChildren = freshDeadRuns.read(deadRun.id).children.filter((child) => (
    child.stage === 'record-if-needed'
  ));

  assert.equal(recordChildren.length, 2);
  assert.equal(recordChildren[0].jobId, deadRecordId);
  assert.equal(recordChildren[1].jobId, recoveredRecordId);
  assert.equal(recordChildren[1].attempt, 2);
});

test('запуск публикует только безопасную проекцию и запись диска предшествует ответу', async (t) => {
  const item = await fixture(t);
  const run = await item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID);

  await item.ops.poll();

  const files = await readdir(path.join(item.root, 'builds'));
  const publicJson = JSON.stringify(parseShowcaseBuildRun(run));

  assert.ok(files.includes(`${run.id}.json`));
  assert.ok(!publicJson.includes(REQUEST_ID));
  assert.ok(!publicJson.includes(buildRunSnapshotOf(item.project).inputHash));
  assert.equal(toPublicBuildRun(item.buildRuns.read(run.id)).id, run.id);
});

test('ошибка атомарной записи не оставляет run, а старый терминальный журнал очищается', async (t) => {
  const item = await fixture(t);
  const runsDir = path.join(item.root, 'builds');

  await rm(runsDir, { recursive: true, force: true });
  await writeFile(runsDir, 'не каталог', 'utf8');

  await assert.rejects(() => item.ops.startBuild(PROJECT_ID, 1, REQUEST_ID));
  assert.equal(item.buildRuns.list().length, 0);

  const cleanupRoot = await mkdtemp(path.join(os.tmpdir(), 'showcase-build-cleanup-'));

  t.after(() => rm(cleanupRoot, { recursive: true, force: true }));

  const cleanupRuns = createShowcaseBuildRuns({
    runsDir: cleanupRoot,
    broadcast: () => {},
    limits: () => ({ retentionDays: 1, maxRuns: 10 }),
  });

  await cleanupRuns.recover();

  const snapshot = buildRunSnapshotOf(project());
  const created = await cleanupRuns.create({
    projectId: PROJECT_ID,
    initialRevision: 1,
    requestId: 'build-cleanup-0001',
    requestInputHash: snapshot.inputHash,
    snapshot,
    previousFinal: null,
  });

  await cleanupRuns.finish(created.record.id, 'failed', { code: 'test', message: 'тест' });

  const file = path.join(cleanupRoot, `${created.record.id}.json`);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  await writeFile(file, JSON.stringify({ ...stored, updatedAt: old, finishedAt: old }), 'utf8');

  const recovered = createShowcaseBuildRuns({
    runsDir: cleanupRoot,
    broadcast: () => {},
    limits: () => ({ retentionDays: 1, maxRuns: 10 }),
  });

  await recovered.recover();
  assert.equal(recovered.list().length, 0);
});

test('журнал не превышает maxRuns, если освободить место по retention нельзя', async (t) => {
  const item = await fixture(t, { maxRuns: 1 });
  const snapshot = buildRunSnapshotOf(item.project);
  const first = await item.buildRuns.create({
    projectId: PROJECT_ID,
    initialRevision: 1,
    requestId: REQUEST_ID,
    requestInputHash: snapshot.inputHash,
    snapshot,
    previousFinal: null,
  });

  await item.buildRuns.finish(first.record.id, 'failed', { code: 'test', message: 'тест' });

  await assert.rejects(
    () => item.buildRuns.create({
      projectId: PROJECT_ID,
      initialRevision: 1,
      requestId: 'build-request-limit',
      requestInputHash: snapshot.inputHash,
      snapshot,
      previousFinal: null,
    }),
    (error) => error.code === 'build_run_limit' && error.status === 429,
  );
  assert.equal(item.buildRuns.list().length, 1);
});
