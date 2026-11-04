import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import {
  ModelJobError,
  ModelJobManager,
  readModelJobFile,
  writeModelJobFile,
} from '../../server/src/lib/speech/modelJobs.ts';
import {
  processIdentityMatches,
  readProcessIdentity,
  signalOwnedProcess,
} from '../../server/src/lib/speech/modelJobsProcess.ts';
import settingsModule from '../../server/src/modules/settings/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function tempRoot(t, prefix = 'grigdesk-model-jobs-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function managerFixture(t, {
  deps = {}, onModelReady = null, baseEnv = {}, benchmarkAudioPath = null,
} = {}) {
  const root = await tempRoot(t);
  const jobsDir = path.join(root, 'jobs');
  let sequence = 0;
  let clock = 1_000;
  const launches = [];
  const manager = new ModelJobManager({
    jobsDir,
    mediaHfDir: path.join(root, 'hf'),
    pythonPath: '/unused/test-python',
    baseEnv,
    benchmarkAudioPath,
    onModelReady,
    deps: {
      createJobId: () => `job-${++sequence}`,
      createNonce: () => `nonce-${sequence}`,
      now: () => ++clock,
      launcher: async ({ job }) => {
        launches.push(job);
        return {
          pid: 10_000 + sequence,
          starttime: String(sequence),
          cmdline: `python worker.py ${job.task.nonce}`,
          script: 'worker.py',
          nonce: job.task.nonce,
        };
      },
      processIdentityMatches: () => true,
      sleep: async () => {},
      ...deps,
    },
  });
  return { root, jobsDir, manager, launches };
}

test('model jobs создаёт приватный jobs dir без permissive окна', async (t) => {
  const { jobsDir } = await managerFixture(t);
  assert.equal((await stat(jobsDir)).mode & 0o777, 0o700);
});

test('model jobs принимают только pinned allowlist и строгие benchmark options', async (t) => {
  const { manager, launches } = await managerFixture(t);

  assert.throws(
    () => manager.startDownload('../../arbitrary/repo'),
    (err) => err instanceof ModelJobError && err.code === 'unknown_speech_model',
  );
  assert.throws(
    () => manager.startCopy('Systran/faster-whisper-medium'),
    (err) => err instanceof ModelJobError && err.code === 'unknown_speech_model',
  );
  assert.throws(
    () => manager.startBenchmark({ modelId: 'medium', repo: 'attacker/repo' }),
    (err) => err instanceof ModelJobError && err.code === 'bad_benchmark_setting',
  );
  assert.throws(
    () => manager.startBenchmark({ modelId: 'medium', device: 'remote' }),
    (err) => err instanceof ModelJobError && err.code === 'bad_benchmark_setting',
  );
  assert.equal(launches.length, 0);
});

test('benchmark fail-fast требует доступный operator-supplied audio, путь не публикуется', async (t) => {
  const missing = await managerFixture(t);
  assert.deepEqual(missing.manager.benchmarkStatus(), {
    available: false,
    reason: 'Эталонная запись benchmark не настроена оператором.',
  });
  assert.throws(
    () => missing.manager.startBenchmark({ modelId: 'medium' }),
    (err) => err instanceof ModelJobError
      && err.code === 'speech_benchmark_unavailable'
      && err.statusCode === 409,
  );
  assert.equal(missing.launches.length, 0);

  const audioRoot = await tempRoot(t, 'grigdesk-benchmark-audio-');
  const audioPath = path.join(audioRoot, 'reference.wav');
  await writeFile(audioPath, 'test audio fixture');
  const ready = await managerFixture(t, { benchmarkAudioPath: audioPath });
  assert.deepEqual(ready.manager.benchmarkStatus(), { available: true, reason: null });
  const started = await ready.manager.startBenchmark({
    modelId: 'medium', language: 'ru', device: 'cpu', computeType: 'int8',
  });
  assert.deepEqual(started, { jobId: 'job-1', status: 'queued' });
  const raw = readModelJobFile(ready.jobsDir, started.jobId);
  assert.equal(raw.task.benchmarkAudioPath, audioPath);
  assert.equal(JSON.stringify(ready.manager.readJob(started.jobId)).includes(audioPath), false);
});

test('default launcher изолирует HF cache, добавляет CUDA path и закрепляет worker nonce', async (t) => {
  const root = await tempRoot(t, 'grigdesk-model-launch-');
  const jobsDir = path.join(root, 'jobs');
  const calls = [];
  const child = new EventEmitter();
  child.pid = 4321;
  child.unref = () => calls.push(['unref']);
  child.kill = (signal) => calls.push(['kill', signal]);
  const manager = new ModelJobManager({
    jobsDir,
    mediaHfDir: path.join(root, 'private-hf'),
    pythonPath: '/runtime/venv/bin/python',
    baseEnv: {
      PATH: '/bin',
      HF_HUB_CACHE: '/common/current',
      HUGGINGFACE_HUB_CACHE: '/common/legacy',
      LD_LIBRARY_PATH: '/system/lib',
    },
    deps: {
      createJobId: () => 'spawn-job',
      createNonce: () => 'spawn-nonce',
      now: () => 10,
      accessSync: (...args) => calls.push(['access', ...args]),
      spawn: (binary, argv, options) => {
        calls.push(['spawn', binary, argv, options]);
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      captureProcessIdentity: (pid, expected) => {
        calls.push(['capture', pid, expected]);
        return {
          pid,
          starttime: '42',
          cmdline: `${expected.script} ${expected.nonce}`,
          ...expected,
        };
      },
      processIdentityMatches: () => true,
    },
  });

  assert.deepEqual(await manager.startDownload('small'), {
    jobId: 'spawn-job', status: 'queued',
  });
  const spawnCall = calls.find((call) => call[0] === 'spawn');
  assert.equal(spawnCall[1], '/runtime/venv/bin/python');
  assert.match(spawnCall[2][0], /model-jobs-worker\.py$/);
  assert.equal(spawnCall[2][1], path.join(jobsDir, 'spawn-job.json'));
  assert.equal(spawnCall[2][2], 'spawn-nonce');
  assert.equal(spawnCall[3].detached, true);
  assert.equal(spawnCall[3].env.HF_HOME, path.join(root, 'private-hf'));
  assert.equal(spawnCall[3].env.HF_XET_CACHE, path.join(root, 'private-hf', 'xet'));
  assert.equal(Object.hasOwn(spawnCall[3].env, 'HF_HUB_CACHE'), false);
  assert.equal(Object.hasOwn(spawnCall[3].env, 'HUGGINGFACE_HUB_CACHE'), false);
  assert.equal(
    spawnCall[3].env.LD_LIBRARY_PATH,
    '/runtime/venv/site-packages/nvidia/cublas/lib:/system/lib',
  );
  assert.equal(manager.readJob('spawn-job').status, 'running');
});

test('default launcher не сигналит по raw PID при сбое capture identity', async (t) => {
  const root = await tempRoot(t, 'grigdesk-model-launch-identity-failure-');
  const child = new EventEmitter();
  const signals = [];
  child.pid = 5432;
  child.unref = () => {};
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const manager = new ModelJobManager({
    jobsDir: path.join(root, 'jobs'),
    mediaHfDir: path.join(root, 'private-hf'),
    pythonPath: '/runtime/venv/bin/python',
    deps: {
      createJobId: () => 'capture-failed-job',
      createNonce: () => 'capture-failed-nonce',
      now: () => 10,
      accessSync: () => {},
      spawn: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      captureProcessIdentity: () => null,
      sleep: async () => {},
    },
  });

  assert.deepEqual(await manager.startDownload('small'), {
    jobId: 'capture-failed-job', status: 'queued',
  });
  assert.equal(manager.readJob('capture-failed-job').status, 'failed');
  assert.deepEqual(signals, [], 'без exact identity child.kill не вызывается');
});

test('download/copy дедуплицируются, progress публичен, internals скрыты', async (t) => {
  const ready = [];
  const { manager, jobsDir, launches } = await managerFixture(t, {
    baseEnv: {
      HOME: '/home/test',
      HF_HUB_CACHE: '/common/hub',
      HUGGINGFACE_HUB_CACHE: '/legacy/hub',
    },
    onModelReady: (modelId) => ready.push(modelId),
  });

  const first = await manager.startDownload('medium');
  const duplicateDownload = await manager.startDownload('medium');
  const duplicateCopy = await manager.startCopy('medium');
  assert.deepEqual(first, { jobId: 'job-1', status: 'queued' });
  assert.deepEqual(duplicateDownload, {
    jobId: 'job-1', status: 'queued', deduplicated: true,
  });
  assert.deepEqual(duplicateCopy, {
    jobId: 'job-1', status: 'queued', deduplicated: true,
  });
  assert.equal(launches.length, 1);

  const raw = readModelJobFile(jobsDir, first.jobId);
  assert.equal(raw.task.model.repo, 'Systran/faster-whisper-medium');
  assert.match(raw.task.model.revision, /^[a-f0-9]{40}$/);
  assert.deepEqual(raw.task.sourceCacheEnv, {
    HOME: '/home/test',
    HF_HUB_CACHE: '/common/hub',
    HUGGINGFACE_HUB_CACHE: '/legacy/hub',
  });
  writeModelJobFile(jobsDir, {
    ...raw,
    progress: { done: 25, total: 100, file: 'model.bin' },
  });

  const running = manager.readJob(first.jobId);
  assert.deepEqual(running.progress, { done: 25, total: 100, file: 'model.bin' });
  assert.equal(running.status, 'running');
  assert.equal(Object.hasOwn(running, 'task'), false);
  assert.equal(Object.hasOwn(running, 'process'), false);

  const latest = readModelJobFile(jobsDir, first.jobId);
  writeModelJobFile(jobsDir, {
    ...latest,
    status: 'done',
    finishedAt: 2_000,
    result: { modelId: 'medium', cached: true },
  });
  const done = manager.readJob(first.jobId);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { modelId: 'medium', cached: true });
  assert.deepEqual(ready, ['medium']);
  manager.readJob(first.jobId);
  assert.deepEqual(ready, ['medium'], 'capabilities инвалидируется один раз на job');

  const afterDone = await manager.startCopy('medium');
  assert.equal(afterDone.jobId, 'job-2');
  assert.equal(launches.length, 2);
});

test('reconcileCompleted замечает detached download без открытого job polling', async (t) => {
  const ready = [];
  const { manager, jobsDir } = await managerFixture(t, {
    onModelReady: (modelId) => ready.push(modelId),
  });
  const started = await manager.startDownload('medium');
  const raw = readModelJobFile(jobsDir, started.jobId);
  writeModelJobFile(jobsDir, {
    ...raw,
    status: 'done',
    finishedAt: 2_000,
    result: { modelId: 'medium', cached: true },
  });

  assert.deepEqual(ready, [], 'закрытая вкладка не читала job status');
  assert.equal(await manager.reconcileCompleted(), 1);
  assert.deepEqual(ready, ['medium']);
  assert.equal(await manager.reconcileCompleted(), 0, 'один terminal job инвалидирует cache один раз');
});

test('ошибка launch остаётся терминальным job, а start сохраняет 202 queued contract', async (t) => {
  const { manager } = await managerFixture(t, {
    deps: {
      launcher: async () => {
        throw new ModelJobError('speech_python_missing', 'нет venv', 503);
      },
    },
  });

  const started = await manager.startDownload('small');
  assert.deepEqual(started, { jobId: 'job-1', status: 'queued' });
  const failed = manager.readJob(started.jobId);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, { code: 'speech_python_missing', message: 'нет venv' });
});

test('cancel во время launch не воскресает failed-статусом после поздней ошибки spawn', async (t) => {
  let rejectLaunch;
  let launchCalls = 0;
  const { manager, launches } = await managerFixture(t, {
    deps: {
      launcher: ({ job }) => {
        launchCalls += 1;
        launches.push(job);
        if (launchCalls === 1) {
          return new Promise((_resolve, reject) => { rejectLaunch = reject; });
        }
        return Promise.resolve({
          pid: 10_000 + launchCalls,
          starttime: String(launchCalls),
          cmdline: `python worker.py ${job.task.nonce}`,
          script: 'worker.py',
          nonce: job.task.nonce,
        });
      },
      signalOwnedProcess: () => false,
    },
  });
  const starting = manager.startDownload('small');
  const cancelled = await manager.cancelJob('job-1');
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(await manager.startCopy('small'), {
    jobId: 'job-1', status: 'queued', deduplicated: true,
  });
  assert.equal(launchCalls, 1);
  rejectLaunch(new Error('late spawn error'));
  assert.deepEqual(await starting, { jobId: 'job-1', status: 'queued' });
  assert.equal(manager.readJob('job-1').status, 'cancelled');
  assert.equal((await manager.startCopy('small')).jobId, 'job-2');
  assert.equal(launchCalls, 2);
});

test('cancel удерживает key до смерти worker из позднего successful launcher', async (t) => {
  let resolveLaunch;
  let launchCalls = 0;
  let oldAlive = true;
  let releaseTermWait;
  let sleepCalls = 0;
  const firstLaunch = new Promise((resolve) => { resolveLaunch = resolve; });
  const firstWait = new Promise((resolve) => { releaseTermWait = resolve; });
  const signals = [];
  const fixture = await managerFixture(t, {
    deps: {
      launcher: ({ job }) => {
        launchCalls += 1;
        fixture.launches.push(job);
        if (launchCalls === 1) return firstLaunch;
        return Promise.resolve({
          pid: 9_002,
          starttime: 'new',
          cmdline: `python /worker.py ${job.task.nonce}`,
          script: '/worker.py',
          nonce: job.task.nonce,
        });
      },
      processIdentityMatches: (identity) => identity.starttime === 'old' && oldAlive,
      signalOwnedProcess: (identity, signal) => {
        signals.push({ identity, signal });
        if (signal === 'SIGKILL') oldAlive = false;
        return true;
      },
      sleep: async () => {
        sleepCalls += 1;
        if (sleepCalls === 1) await firstWait;
      },
    },
  });

  const starting = fixture.manager.startDownload('medium');
  const cancelled = await fixture.manager.cancelJob('job-1');
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(await fixture.manager.startCopy('medium'), {
    jobId: 'job-1', status: 'queued', deduplicated: true,
  });
  assert.equal(launchCalls, 1);

  resolveLaunch({
    pid: 9_001,
    starttime: 'old',
    cmdline: 'python /worker.py nonce-1',
    script: '/worker.py',
    nonce: 'nonce-1',
  });
  while (signals.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals.map(({ signal }) => signal), ['SIGTERM']);
  assert.deepEqual(await fixture.manager.startCopy('medium'), {
    jobId: 'job-1', status: 'queued', deduplicated: true,
  });
  assert.equal(launchCalls, 1, 'поздний worker ещё жив — второй launcher закрыт');

  releaseTermWait();
  assert.deepEqual(await starting, { jobId: 'job-1', status: 'queued' });
  assert.deepEqual(signals.map(({ signal }) => signal), ['SIGTERM', 'SIGKILL']);
  assert.equal(readModelJobFile(fixture.jobsDir, 'job-1').process.starttime, 'old');

  assert.equal((await fixture.manager.startCopy('medium')).jobId, 'job-2');
  assert.equal(launchCalls, 2);
});

test('cancel ждёт TERM/KILL death barrier и лишь затем освобождает dedupe', async (t) => {
  const signals = [];
  let alive = true;
  let releaseTermWait;
  let sleepCalls = 0;
  const firstWait = new Promise((resolve) => { releaseTermWait = resolve; });
  const { manager } = await managerFixture(t, {
    deps: {
      processIdentityMatches: () => alive,
      signalOwnedProcess: (identity, signal) => {
        signals.push({ identity, signal });
        if (signal === 'SIGKILL') alive = false;
        return true;
      },
      sleep: async () => {
        sleepCalls += 1;
        if (sleepCalls === 1) await firstWait;
      },
    },
  });
  const started = await manager.startDownload('large-v3');

  const cancelling = manager.cancelJob(started.jobId);
  await Promise.resolve();
  assert.deepEqual(signals.map((entry) => entry.signal), ['SIGTERM']);
  assert.deepEqual(await manager.startCopy('large-v3'), {
    jobId: started.jobId, status: 'queued', deduplicated: true,
  });

  releaseTermWait();
  const cancelled = await cancelling;
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(signals.map((entry) => entry.signal), ['SIGTERM', 'SIGKILL']);
  assert.equal(signals[0].identity.nonce, 'nonce-1');

  const restarted = await manager.startCopy('large-v3');
  assert.equal(restarted.jobId, 'job-2');
});

test('cancelled status до выхода worker сохраняет dedupe, PID reuse не сигналится', async (t) => {
  let alive = true;
  let jobsDir;
  const signals = [];
  const fixture = await managerFixture(t, {
    deps: {
      processIdentityMatches: () => alive,
      signalOwnedProcess: (_identity, signal) => {
        signals.push(signal);
        if (signal === 'SIGTERM') {
          const running = readModelJobFile(jobsDir, 'job-1');
          writeModelJobFile(jobsDir, {
            ...running,
            status: 'cancelled',
            finishedAt: 2_000,
          });
        }
        return true;
      },
    },
  });
  ({ jobsDir } = fixture);
  const started = await fixture.manager.startDownload('medium');

  const cancelled = await fixture.manager.cancelJob(started.jobId);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(await fixture.manager.startCopy('medium'), {
    jobId: started.jobId, status: 'queued', deduplicated: true,
  });
  assert.equal(fixture.launches.length, 1, 'terminal JSON не разрешает второго writer');

  alive = false;
  const restarted = await fixture.manager.startCopy('medium');
  assert.equal(restarted.jobId, 'job-2');
  assert.equal(fixture.launches.length, 2);

  const reused = await fixture.manager.startDownload('small');
  alive = false;
  signals.length = 0;
  const reusedCancelled = await fixture.manager.cancelJob(reused.jobId);
  assert.equal(reusedCancelled.status, 'cancelled');
  assert.deepEqual(signals, [], 'несовпавший exact identity не получает signal');
});

test('restart делает active job interrupted и при PID reuse не сигналит чужой процесс', async (t) => {
  const root = await tempRoot(t, 'grigdesk-model-recovery-');
  const jobsDir = path.join(root, 'jobs');
  const identity = {
    pid: 4242,
    starttime: '100',
    cmdline: 'python /worker.py nonce-old',
    script: '/worker.py',
    nonce: 'nonce-old',
  };
  writeModelJobFile(jobsDir, {
    jobId: 'old-job',
    kind: 'download',
    modelId: 'medium',
    status: 'running',
    createdAt: 10,
    startedAt: 11,
    finishedAt: null,
    progress: { done: 5, total: 10, file: 'model.bin' },
    result: null,
    error: null,
    process: identity,
    task: { nonce: 'nonce-old' },
  });

  const kills = [];
  const safeSignal = (expected, signal) => signalOwnedProcess(expected, signal, {
    readProcessIdentity: () => ({
      pid: 4242,
      starttime: '101',
      cmdline: 'unrelated process',
    }),
    kill: (...args) => kills.push(args),
  });
  const manager = new ModelJobManager({
    jobsDir,
    mediaHfDir: path.join(root, 'hf'),
    pythonPath: '/unused/test-python',
    deps: { now: () => 99, signalOwnedProcess: safeSignal },
  });

  const recovered = manager.readJob('old-job');
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.finishedAt, 99);
  assert.equal(recovered.error.code, 'model_job_interrupted');
  assert.deepEqual(kills, [], 'совпадения PID недостаточно для signal');
});

test('restart держит dedupe до TERM/KILL и подтверждённой смерти прежнего worker', async (t) => {
  const root = await tempRoot(t, 'grigdesk-model-recovery-wait-');
  const jobsDir = path.join(root, 'jobs');
  const identity = {
    pid: 4343,
    starttime: '200',
    cmdline: 'python /worker.py nonce-old',
    script: '/worker.py',
    nonce: 'nonce-old',
  };
  writeModelJobFile(jobsDir, {
    jobId: 'old-job',
    kind: 'download',
    modelId: 'medium',
    status: 'running',
    createdAt: 10,
    startedAt: 11,
    finishedAt: null,
    progress: null,
    result: null,
    error: null,
    process: identity,
    task: { nonce: 'nonce-old' },
  });

  let alive = true;
  let releaseTermWait;
  let sleepCalls = 0;
  const firstWait = new Promise((resolve) => { releaseTermWait = resolve; });
  const signals = [];
  const launches = [];
  const manager = new ModelJobManager({
    jobsDir,
    mediaHfDir: path.join(root, 'hf'),
    pythonPath: '/unused/test-python',
    deps: {
      now: () => 99,
      createJobId: () => 'new-job',
      createNonce: () => 'nonce-new',
      processIdentityMatches: () => alive,
      signalOwnedProcess: (expected, signal) => {
        signals.push({ expected, signal });
        if (signal === 'SIGKILL') alive = false;
        return true;
      },
      sleep: async () => {
        sleepCalls += 1;
        if (sleepCalls === 1) await firstWait;
      },
      launcher: async ({ job }) => {
        launches.push(job.jobId);
        return {
          pid: 5353,
          starttime: '300',
          cmdline: `python /worker.py ${job.task.nonce}`,
          script: '/worker.py',
          nonce: job.task.nonce,
        };
      },
    },
  });

  const restarting = manager.startCopy('medium');
  await Promise.resolve();
  assert.deepEqual(signals.map(({ signal }) => signal), ['SIGTERM']);
  assert.deepEqual(launches, [], 'новый writer не стартует, пока прежний worker ещё жив');
  assert.equal(readModelJobFile(jobsDir, 'old-job').status, 'running');

  releaseTermWait();
  const restarted = await restarting;
  assert.deepEqual(signals.map(({ signal }) => signal), ['SIGTERM', 'SIGKILL']);
  assert.equal(signals[1].expected.starttime, identity.starttime);
  assert.equal(signals[1].expected.nonce, identity.nonce);
  assert.equal(readModelJobFile(jobsDir, 'old-job').status, 'interrupted');
  assert.deepEqual(launches, ['new-job']);
  assert.deepEqual(restarted, { jobId: 'new-job', status: 'queued' });
});

test('terminal status прежнего worker не освобождает dedupe без подтверждения смерти', async (t) => {
  const root = await tempRoot(t, 'grigdesk-model-recovery-terminal-');
  const jobsDir = path.join(root, 'jobs');
  const identity = {
    pid: 4444,
    starttime: '210',
    cmdline: 'python /worker.py nonce-old',
    script: '/worker.py',
    nonce: 'nonce-old',
  };
  const old = writeModelJobFile(jobsDir, {
    jobId: 'old-job',
    kind: 'copy',
    modelId: 'small',
    status: 'running',
    createdAt: 10,
    startedAt: 11,
    finishedAt: null,
    progress: null,
    result: null,
    error: null,
    process: identity,
    task: { nonce: 'nonce-old' },
  });
  let alive = true;
  const launches = [];
  const manager = new ModelJobManager({
    jobsDir,
    mediaHfDir: path.join(root, 'hf'),
    pythonPath: '/unused/test-python',
    deps: {
      now: () => 99,
      createJobId: () => 'new-job',
      createNonce: () => 'nonce-new',
      processIdentityMatches: () => alive,
      signalOwnedProcess: (_expected, signal) => {
        if (signal === 'SIGTERM') {
          writeModelJobFile(jobsDir, {
            ...old,
            status: 'cancelled',
            finishedAt: 50,
          });
        }
        return true;
      },
      sleep: async () => {},
      launcher: async ({ job }) => {
        launches.push(job.jobId);
        return {
          pid: 5454,
          starttime: '310',
          cmdline: `python /worker.py ${job.task.nonce}`,
          script: '/worker.py',
          nonce: job.task.nonce,
        };
      },
    },
  });

  assert.deepEqual(await manager.startDownload('small'), {
    jobId: 'old-job', status: 'queued', deduplicated: true,
  });
  assert.deepEqual(launches, [], 'terminal JSON не доказывает завершение старого writer');

  alive = false;
  assert.deepEqual(await manager.startDownload('small'), { jobId: 'new-job', status: 'queued' });
  assert.deepEqual(launches, ['new-job']);
});

test('Python worker создаёт status tmp сразу с 0600 и O_EXCL', () => {
  const workerPath = fileURLToPath(new URL('../../server/src/lib/speech/model-jobs-worker.py', import.meta.url));
  const source = String.raw`
import importlib.util, json, os, pathlib, sys, tempfile

with tempfile.TemporaryDirectory() as root:
    worker_path = sys.argv[1]
    status = pathlib.Path(root) / 'job.json'
    status.write_text('{}', encoding='utf-8')
    sys.argv = [sys.argv[0], str(status), 'nonce']
    spec = importlib.util.spec_from_file_location('grigdesk_model_worker', worker_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    real_open = module.os.open
    real_replace = module.os.replace
    observed = {}
    def secure_open(path, flags, mode=0o777):
        observed['flags'] = flags
        observed['requestedMode'] = mode
        return real_open(path, flags, mode)
    def inspect_replace(source, destination):
        observed['createdMode'] = pathlib.Path(source).stat().st_mode & 0o777
        return real_replace(source, destination)
    module.os.open = secure_open
    module.os.replace = inspect_replace
    module.atomic_write({'status': 'running'})
    # os общий для всех модулей; TemporaryDirectory использует open с dir_fd при очистке.
    module.os.open = real_open
    module.os.replace = real_replace
    print(json.dumps({
        **observed,
        'exclusive': bool(observed['flags'] & os.O_EXCL),
        'contents': json.loads(status.read_text(encoding='utf-8')),
    }))
`;
  const run = spawnSync('python3', ['-B', '-c', source, workerPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.requestedMode, 0o600);
  assert.equal(result.createdMode, 0o600);
  assert.equal(result.exclusive, true);
  assert.deepEqual(result.contents, { status: 'running' });
});

test('process identity требует starttime, cmdline, script и nonce', () => {
  const identity = {
    pid: 777,
    starttime: '42',
    cmdline: 'python /srv/model-jobs-worker.py nonce-7',
    script: '/srv/model-jobs-worker.py',
    nonce: 'nonce-7',
  };
  const exact = { readProcessIdentity: () => ({
    pid: 777,
    starttime: '42',
    cmdline: 'python /srv/model-jobs-worker.py nonce-7',
  }) };
  assert.equal(processIdentityMatches(identity, exact), true);
  assert.equal(processIdentityMatches(identity, {
    readProcessIdentity: () => ({ ...exact.readProcessIdentity(), starttime: '43' }),
  }), false);
  assert.equal(processIdentityMatches(identity, {
    readProcessIdentity: () => ({ ...exact.readProcessIdentity(), cmdline: 'python another.py' }),
  }), false);

  const kills = [];
  assert.equal(signalOwnedProcess(identity, 'SIGTERM', {
    ...exact,
    kill: (...args) => kills.push(args),
  }), true);
  assert.deepEqual(kills, [[777, 'SIGTERM']]);
});

test('readProcessIdentity читает Linux starttime даже со скобками в comm', () => {
  const tail = ['S', ...Array(18).fill('0'), '424242'];
  const identity = readProcessIdentity(777, {
    readFileSync: (filePath) => (filePath.endsWith('/stat')
      ? `777 (python (model job)) ${tail.join(' ')}`
      : 'python\0/srv/model-jobs-worker.py\0nonce-7\0'),
  });
  assert.deepEqual(identity, {
    pid: 777,
    starttime: '424242',
    cmdline: 'python /srv/model-jobs-worker.py nonce-7',
  });
});

async function settingsApp(t, modelJobs) {
  const root = await tempRoot(t, 'grigdesk-model-api-');
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(settingsModule, {
    prefs: new PrefsStore({ prefsPath: path.join(root, 'prefs.json') }),
    factoryDebug: {},
    speechRuntime: { capabilities: async () => ({ local: { ready: false } }) },
    modelJobs,
  });
  return app;
}

test('settings routes отдают единый 202/read/cancel contract и ошибки allowlist', async (t) => {
  const calls = [];
  const full = {
    jobId: 'job-api',
    kind: 'download',
    modelId: 'medium',
    status: 'running',
    createdAt: 1,
    startedAt: 2,
    finishedAt: null,
    progress: { done: 1, total: 4, file: 'model.bin' },
    result: null,
    error: null,
  };
  const modelJobs = {
    startDownload: async (modelId) => {
      calls.push(['download', modelId]);
      if (modelId === 'unknown') {
        throw new ModelJobError('unknown_speech_model', 'неизвестная модель');
      }
      return { jobId: 'job-api', status: 'queued' };
    },
    startCopy: async (modelId) => {
      calls.push(['copy', modelId]);
      return { jobId: 'job-copy', status: 'queued' };
    },
    startBenchmark: async (options) => {
      calls.push(['benchmark', options]);
      return { jobId: 'job-bench', status: 'queued' };
    },
    readJob: async (jobId) => (jobId === 'missing' ? null : full),
    cancelJob: async (jobId) => (jobId === 'missing' ? null : { ...full, status: 'cancelled' }),
  };
  const app = await settingsApp(t, modelJobs);

  const download = await app.inject({
    method: 'POST', url: '/api/settings/speech/models/medium/download',
  });
  assert.equal(download.statusCode, 202);
  assert.deepEqual(download.json(), { jobId: 'job-api', status: 'queued' });

  const copy = await app.inject({
    method: 'POST', url: '/api/settings/speech/models/small/copy',
  });
  assert.equal(copy.statusCode, 202);
  assert.deepEqual(copy.json(), { jobId: 'job-copy', status: 'queued' });

  const benchmark = await app.inject({
    method: 'POST',
    url: '/api/settings/speech/benchmark',
    payload: { modelId: 'medium', language: 'ru' },
  });
  assert.equal(benchmark.statusCode, 202);
  assert.deepEqual(benchmark.json(), { jobId: 'job-bench', status: 'queued' });
  assert.deepEqual(calls, [
    ['download', 'medium'],
    ['copy', 'small'],
    ['benchmark', { modelId: 'medium', language: 'ru' }],
  ]);

  const read = await app.inject({ method: 'GET', url: '/api/settings/speech/jobs/job-api' });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), full);
  assert.equal(Object.hasOwn(read.json(), 'task'), false);
  assert.equal(Object.hasOwn(read.json(), 'process'), false);
  assert.equal(JSON.stringify(read.json()).includes('sourceCacheEnv'), false);
  const cancel = await app.inject({ method: 'DELETE', url: '/api/settings/speech/jobs/job-api' });
  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.json().status, 'cancelled');

  const missing = await app.inject({ method: 'GET', url: '/api/settings/speech/jobs/missing' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'speech_job_not_found');
  const unknown = await app.inject({
    method: 'POST', url: '/api/settings/speech/models/unknown/download',
  });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().error, 'unknown_speech_model');
});

test('settings HTTP сохраняет реальную manager-дедупликацию и безопасный cancel', async (t) => {
  const { manager } = await managerFixture(t, {
    deps: { signalOwnedProcess: () => false },
  });
  const app = await settingsApp(t, manager);

  const first = await app.inject({
    method: 'POST', url: '/api/settings/speech/models/medium/download',
  });
  const duplicate = await app.inject({
    method: 'POST', url: '/api/settings/speech/models/medium/copy',
  });
  assert.equal(first.statusCode, 202);
  assert.equal(duplicate.statusCode, 202);
  assert.equal(duplicate.json().jobId, first.json().jobId);
  assert.equal(duplicate.json().status, 'queued');
  assert.equal(duplicate.json().deduplicated, true);

  const status = await app.inject({
    method: 'GET', url: `/api/settings/speech/jobs/${first.json().jobId}`,
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().status, 'running');
  assert.equal(Object.hasOwn(status.json(), 'task'), false);
  assert.equal(Object.hasOwn(status.json(), 'process'), false);
  assert.equal(JSON.stringify(status.json()).includes('sourceCacheEnv'), false);

  const cancel = await app.inject({
    method: 'DELETE', url: `/api/settings/speech/jobs/${first.json().jobId}`,
  });
  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.json().status, 'cancelled');
  const missing = await app.inject({
    method: 'GET', url: '/api/settings/speech/jobs/no-such-job',
  });
  assert.equal(missing.statusCode, 404);

  const unavailableBenchmark = await app.inject({
    method: 'POST',
    url: '/api/settings/speech/benchmark',
    payload: { modelId: 'medium' },
  });
  assert.equal(unavailableBenchmark.statusCode, 409);
  assert.equal(unavailableBenchmark.json().error, 'speech_benchmark_unavailable');
  const speech = await app.inject({ method: 'GET', url: '/api/settings/speech' });
  assert.deepEqual(speech.json().capabilities.benchmark, {
    available: false,
    reason: 'Эталонная запись benchmark не настроена оператором.',
  });
});

test('settings HTTP запускает benchmark только с доступным эталоном', async (t) => {
  const audioRoot = await tempRoot(t, 'grigdesk-benchmark-http-');
  const audioPath = path.join(audioRoot, 'reference.wav');
  await writeFile(audioPath, 'test audio fixture');
  const { manager } = await managerFixture(t, { benchmarkAudioPath: audioPath });
  const app = await settingsApp(t, manager);

  const speech = await app.inject({ method: 'GET', url: '/api/settings/speech' });
  assert.deepEqual(speech.json().capabilities.benchmark, { available: true, reason: null });
  const benchmark = await app.inject({
    method: 'POST',
    url: '/api/settings/speech/benchmark',
    payload: { modelId: 'medium', language: 'ru', device: 'cpu' },
  });
  assert.equal(benchmark.statusCode, 202);
  assert.deepEqual(benchmark.json(), { jobId: 'job-1', status: 'queued' });
});

test('settings model routes fail closed без coordinator', async (t) => {
  const app = await settingsApp(t, null);
  const response = await app.inject({
    method: 'POST', url: '/api/settings/speech/models/medium/download',
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, 'speech_model_jobs_unavailable');
});

test('Python download preflight возвращает no-space до snapshot_download и без сети', () => {
  const workerPath = fileURLToPath(new URL('../../server/src/lib/speech/model-jobs-worker.py', import.meta.url));
  const source = String.raw`
import errno, importlib.util, json, pathlib, sys, tempfile, types

root = tempfile.TemporaryDirectory()
hub = pathlib.Path(root.name) / 'hub'
calls = []

class HfApi:
    def model_info(self, **_kwargs):
        return types.SimpleNamespace(siblings=[types.SimpleNamespace(size=1024, lfs=None)])

def snapshot_download(**kwargs):
    calls.append(kwargs)
    return str(hub / 'snapshot')

hf = types.ModuleType('huggingface_hub')
hf.HfApi = HfApi
hf.snapshot_download = snapshot_download
constants = types.ModuleType('huggingface_hub.constants')
constants.HF_HUB_CACHE = str(hub)
tqdm_auto = types.ModuleType('tqdm.auto')
tqdm_auto.tqdm = object
sys.modules['huggingface_hub'] = hf
sys.modules['huggingface_hub.constants'] = constants
sys.modules['tqdm'] = types.ModuleType('tqdm')
sys.modules['tqdm.auto'] = tqdm_auto

spec = importlib.util.spec_from_file_location('grigdesk_model_worker', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.shutil.disk_usage = lambda _path: types.SimpleNamespace(free=1)
task = {'model': {'modelId': 'medium', 'repo': 'Systran/faster-whisper-medium', 'revision': 'a' * 40}}
try:
    module.download(task)
except OSError as exc:
    blocked_calls = list(calls)
    resume_model = hub / 'models--org--repo'
    blobs = resume_model / 'blobs'
    blobs.mkdir(parents=True)
    (blobs / 'sha.incomplete').write_bytes(b'x' * 800)
    resume_info = types.SimpleNamespace(siblings=[
        types.SimpleNamespace(size=1024, lfs={'size': 1024, 'sha256': 'sha'})
    ])
    calls.clear()
    module.shutil.disk_usage = lambda _path: types.SimpleNamespace(free=2048)
    completed = module.download(task)
    print(json.dumps({
        'errno': exc.errno,
        'code': module.error_code(exc, 'download'),
        'blockedCalls': blocked_calls,
        'resumeRemaining': module.remaining_download_bytes(resume_info, resume_model),
        'completed': completed,
        'downloadCalls': [{
            'revision': call.get('revision'),
            'localOnly': call.get('local_files_only', False),
            'hasProgress': 'tqdm_class' in call,
        } for call in calls],
    }))
else:
    raise AssertionError('ожидался ENOSPC')
`;
  const run = spawnSync('python3', ['-B', '-c', source, workerPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    errno: 28,
    code: 'speech_model_no_space',
    blockedCalls: [],
    resumeRemaining: 224,
    completed: {
      modelId: 'medium',
      repo: 'Systran/faster-whisper-medium',
      revision: 'a'.repeat(40),
      cached: true,
    },
    downloadCalls: [
      { revision: 'a'.repeat(40), localOnly: false, hasProgress: true },
      { revision: 'a'.repeat(40), localOnly: true, hasProgress: false },
    ],
  });
});

test('Python copy переносит только allowlisted model tree атомарно и сохраняет source', () => {
  const workerPath = fileURLToPath(new URL('../../server/src/lib/speech/model-jobs-worker.py', import.meta.url));
  const source = String.raw`
import importlib.util, json, pathlib, sys, tempfile, types

root = tempfile.TemporaryDirectory()
base = pathlib.Path(root.name)
common_hub = base / 'common-hub'
target_hub = base / 'target-hub'
model_name = 'models--Systran--faster-whisper-medium'
revision = 'a' * 40
source_model = common_hub / model_name
source_snapshot = source_model / 'snapshots' / revision
source_blobs = source_model / 'blobs'
source_snapshot.mkdir(parents=True)
source_blobs.mkdir(parents=True)
(source_blobs / 'weights').write_bytes(b'w' * 64)
(source_blobs / 'config').write_bytes(b'{}')
(source_snapshot / 'model.bin').symlink_to('../../blobs/weights')
(source_snapshot / 'config.json').symlink_to('../../blobs/config')

calls = []
def snapshot_download(**kwargs):
    calls.append(kwargs)
    cache_dir = pathlib.Path(kwargs.get('cache_dir') or target_hub)
    selected_name = 'models--' + kwargs['repo_id'].replace('/', '--')
    candidate = cache_dir / selected_name / 'snapshots' / kwargs['revision']
    if not candidate.exists():
        raise FileNotFoundError(candidate)
    return str(candidate)

hf = types.ModuleType('huggingface_hub')
hf.snapshot_download = snapshot_download
constants = types.ModuleType('huggingface_hub.constants')
constants.HF_HUB_CACHE = str(target_hub)
sys.modules['huggingface_hub'] = hf
sys.modules['huggingface_hub.constants'] = constants

spec = importlib.util.spec_from_file_location('grigdesk_model_worker', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.source_hub = lambda _env: common_hub
module.report_progress = lambda *_args: None
task = {
    'model': {
        'modelId': 'medium',
        'repo': 'Systran/faster-whisper-medium',
        'revision': revision,
    },
    'sourceCacheEnv': {},
}
result = module.copy_cached(task, 'copy-job')
canonical_calls = list(calls)
calls.clear()
target_model = target_hub / model_name
target_snapshot = target_model / 'snapshots' / revision

alias_repo = 'mobiuslabsgmbh/faster-whisper-large-v3-turbo'
alias_name = 'models--mobiuslabsgmbh--faster-whisper-large-v3-turbo'
alias_source_model = common_hub / alias_name
alias_source_snapshot = alias_source_model / 'snapshots' / revision
alias_source_blobs = alias_source_model / 'blobs'
alias_source_snapshot.mkdir(parents=True)
alias_source_blobs.mkdir(parents=True)
(alias_source_blobs / 'weights').write_bytes(b'a' * 32)
(alias_source_blobs / 'config').write_bytes(b'{}')
(alias_source_snapshot / 'model.bin').symlink_to('../../blobs/weights')
(alias_source_snapshot / 'config.json').symlink_to('../../blobs/config')
alias_result = module.copy_cached({
    'model': {
        'modelId': 'large-v3-turbo',
        'repo': 'dropbox-dash/faster-whisper-large-v3-turbo',
        'revision': revision,
        'aliases': [alias_repo],
    },
    'sourceCacheEnv': {},
}, 'alias-copy-job')
alias_target_snapshot = target_hub / alias_name / 'snapshots' / revision

def public_calls(items):
    return [{
        'repo': call.get('repo_id'),
        'revision': call.get('revision'),
        'localOnly': call.get('local_files_only', False),
        'cacheKind': (
            'target-final' if not call.get('cache_dir')
            else 'source' if pathlib.Path(call['cache_dir']) == common_hub
            else 'target-temp'
        ),
    } for call in items]

print(json.dumps({
    'result': result,
    'sourceExists': (source_snapshot / 'model.bin').exists(),
    'sourceBytes': (source_blobs / 'weights').read_bytes().decode(),
    'targetExists': (target_snapshot / 'model.bin').exists(),
    'targetIsSymlink': (target_snapshot / 'model.bin').is_symlink(),
    'targetBytes': (target_snapshot / 'model.bin').read_bytes().decode(),
    'tempExists': (target_hub / '.grigdesk-copy-copy-job').exists(),
    'calls': public_calls(canonical_calls),
    'aliasResult': alias_result,
    'aliasSourceExists': (alias_source_snapshot / 'model.bin').exists(),
    'aliasTargetExists': (alias_target_snapshot / 'model.bin').exists(),
    'aliasTargetBytes': (alias_target_snapshot / 'model.bin').read_bytes().decode(),
    'aliasTempExists': (target_hub / '.grigdesk-copy-alias-copy-job').exists(),
    'aliasCalls': public_calls(calls),
}))
`;
  const run = spawnSync('python3', ['-B', '-c', source, workerPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.result.modelId, 'medium');
  assert.equal(result.result.cached, true);
  assert.equal(result.sourceExists, true);
  assert.equal(result.sourceBytes, 'w'.repeat(64));
  assert.equal(result.targetExists, true);
  assert.equal(result.targetIsSymlink, true);
  assert.equal(result.targetBytes, 'w'.repeat(64));
  assert.equal(result.tempExists, false);
  assert.deepEqual(result.calls, [
    {
      repo: 'Systran/faster-whisper-medium',
      revision: 'a'.repeat(40),
      localOnly: true,
      cacheKind: 'source',
    },
    {
      repo: 'Systran/faster-whisper-medium',
      revision: 'a'.repeat(40),
      localOnly: true,
      cacheKind: 'target-temp',
    },
    {
      repo: 'Systran/faster-whisper-medium',
      revision: 'a'.repeat(40),
      localOnly: true,
      cacheKind: 'target-final',
    },
  ]);
  assert.equal(result.aliasResult.repo, 'mobiuslabsgmbh/faster-whisper-large-v3-turbo');
  assert.equal(result.aliasResult.revision, 'a'.repeat(40));
  assert.equal(result.aliasSourceExists, true);
  assert.equal(result.aliasTargetExists, true);
  assert.equal(result.aliasTargetBytes, 'a'.repeat(32));
  assert.equal(result.aliasTempExists, false);
  assert.deepEqual(result.aliasCalls, [
    {
      repo: 'dropbox-dash/faster-whisper-large-v3-turbo',
      revision: 'a'.repeat(40),
      localOnly: true,
      cacheKind: 'source',
    },
    {
      repo: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
      revision: 'a'.repeat(40),
      localOnly: true,
      cacheKind: 'source',
    },
    {
      repo: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
      revision: 'a'.repeat(40),
      localOnly: true,
      cacheKind: 'target-temp',
    },
    {
      repo: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
      revision: 'a'.repeat(40),
      localOnly: true,
      cacheKind: 'target-final',
    },
  ]);
});

test('benchmark worker использует pinned alias-кэш, если canonical snapshot отсутствует', async (t) => {
  const root = await tempRoot(t, 'grigdesk-benchmark-alias-');
  const audioPath = path.join(root, 'reference.wav');
  await writeFile(audioPath, 'audio');
  const workerPath = fileURLToPath(new URL('../../server/src/lib/speech/model-jobs-worker.py', import.meta.url));
  const source = String.raw`
import importlib.util, json, sys, types
calls = []
alias = 'mobiuslabsgmbh/faster-whisper-large-v3-turbo'
def snapshot_download(**kwargs):
    calls.append(kwargs)
    if kwargs['repo_id'] != alias:
        raise FileNotFoundError(kwargs['repo_id'])
    return '/pinned/alias-snapshot'
class WhisperModel:
    def __init__(self, snapshot, **kwargs):
        calls.append({'snapshot': snapshot, 'modelOptions': kwargs})
    def transcribe(self, audio, **kwargs):
        calls.append({'audio': audio, 'transcribeOptions': kwargs})
        return iter([]), types.SimpleNamespace(duration=2.0)
hf = types.ModuleType('huggingface_hub')
hf.snapshot_download = snapshot_download
fw = types.ModuleType('faster_whisper')
fw.WhisperModel = WhisperModel
sys.modules['huggingface_hub'] = hf
sys.modules['faster_whisper'] = fw
spec = importlib.util.spec_from_file_location('grigdesk_model_worker', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module.benchmark({
    'model': {
        'modelId': 'large-v3-turbo',
        'repo': 'dropbox-dash/faster-whisper-large-v3-turbo',
        'revision': '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
        'aliases': [alias],
    },
    'benchmarkAudioPath': sys.argv[2],
    'benchmark': {'device': 'cpu', 'computeType': 'int8', 'language': 'ru'},
})
print(json.dumps({'calls': calls, 'result': result}))
`;
  const run = spawnSync('python3', ['-B', '-c', source, workerPath, audioPath], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.calls[0].repo_id, 'dropbox-dash/faster-whisper-large-v3-turbo');
  assert.equal(payload.calls[1].repo_id, 'mobiuslabsgmbh/faster-whisper-large-v3-turbo');
  assert.equal(payload.calls[2].snapshot, '/pinned/alias-snapshot');
  assert.equal(payload.result.modelId, 'large-v3-turbo');
  assert.equal(payload.result.audioSec, 2);
});
