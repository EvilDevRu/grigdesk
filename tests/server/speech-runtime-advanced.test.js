import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPEECH_MODEL_CATALOG,
  SpeechRuntime,
} from '../../server/src/lib/speech/index.js';

function models(cachedIds = ['medium']) {
  return Object.values(SPEECH_MODEL_CATALOG).map((model) => ({
    modelId: model.modelId,
    repo: model.repo,
    revision: model.revision,
    cached: cachedIds.includes(model.modelId),
    sizeMb: cachedIds.includes(model.modelId) ? 1 : 0,
  }));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function readyDeps(extra = {}) {
  return {
    preflight: async () => ({ ok: true, checks: [], venvPython: '/venv/python' }),
    probeSpeechModelCache: async () => models(['small', 'medium', 'large-v3', 'large-v3-turbo']),
    runCudaCanary: async () => ({ state: 'no_device', reason: 'нет GPU' }),
    ...extra,
  };
}

test('device:auto пробует известную CUDA с float16 и один раз отступает на CPU/int8', async () => {
  const calls = [];
  const sourceSettings = { quality: 'balanced', device: 'auto' };
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    settings: sourceSettings,
    deps: readyDeps({
      runCudaCanary: async () => ({ state: 'ready', reason: null, device: 0 }),
      async ingestRecording(value) {
        calls.push(value.speech);
        if (calls.length === 1) throw new Error('CUDA out of memory while allocating tensor');
        return { transcript: { segments: [] } };
      },
    }),
  });

  await runtime.capabilities();
  const result = await runtime.transcribe({
    filePath: '/audio.webm',
    workDir: '/work',
    settings: sourceSettings,
  });

  assert.deepEqual(calls.map(({ device, computeType }) => ({ device, computeType })), [
    { device: 'cuda', computeType: 'float16' },
    { device: 'cpu', computeType: 'int8' },
  ]);
  assert.deepEqual(result.execution, {
    engine: 'whisper',
    mode: 'one-shot',
    device: 'cpu',
    fallback: 'cuda_failed',
  });
  assert.deepEqual(sourceSettings, { quality: 'balanced', device: 'auto' });
});

test('explicit CUDA не меняет prefs и не получает скрытый CPU retry', async () => {
  let calls = 0;
  const sourceSettings = { quality: 'balanced', device: 'cuda' };
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    settings: sourceSettings,
    deps: readyDeps({
      runCudaCanary: async () => ({ state: 'ready', reason: null }),
      async ingestRecording({ speech }) {
        calls += 1;
        assert.deepEqual({ device: speech.device, computeType: speech.computeType }, {
          device: 'cuda',
          computeType: 'float16',
        });
        throw new Error('CUDA out of memory');
      },
    }),
  });

  await runtime.capabilities();
  await assert.rejects(
    runtime.transcribe({ filePath: '/audio.webm', workDir: '/work', settings: sourceSettings }),
    /CUDA out of memory/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(sourceSettings, { quality: 'balanced', device: 'cuda' });
});

test('dictation и readiness snapshot не ждут долгий CUDA canary', async () => {
  const canary = deferred();
  const canaryStarted = deferred();
  const ingestCalls = [];
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    settings: { quality: 'balanced', device: 'auto' },
    deps: readyDeps({
      runCudaCanary: async ({ model }) => {
        if (!model) return { state: 'no_device', reason: 'быстрый probe без GPU' };
        canaryStarted.resolve();
        return canary.promise;
      },
      async ingestRecording(value) {
        ingestCalls.push(value.speech);
        return { transcript: { segments: [] } };
      },
    }),
  });

  const fullCapabilities = runtime.capabilities();
  await canaryStarted.promise;
  const readiness = await runtime.publicSnapshotAsync();
  assert.equal(readiness.local.ready, true);

  const transcribe = runtime.transcribe({ filePath: '/audio.webm', workDir: '/work' });
  const winner = await Promise.race([
    transcribe.then(() => 'transcribed'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
  ]);
  assert.equal(winner, 'transcribed');
  assert.deepEqual(
    { device: ingestCalls[0].device, computeType: ingestCalls[0].computeType },
    { device: 'cpu', computeType: 'int8' },
  );

  canary.resolve({ state: 'ready', reason: null });
  await fullCapabilities;
});

test('fresh device:auto лениво и single-flight проверяет CUDA до первого запуска', async () => {
  let cudaProbes = 0;
  const ingests = [];
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    settings: { quality: 'balanced', device: 'auto' },
    deps: readyDeps({
      async runCudaCanary({ model }) {
        assert.equal(model, null, 'fresh execution использует быстрый device/library probe');
        cudaProbes += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return { state: 'ready', reason: null, device: 0 };
      },
      async ingestRecording({ speech }) {
        ingests.push(speech);
        return { transcript: { segments: [] } };
      },
    }),
  });

  await Promise.all([
    runtime.transcribe({ filePath: '/one.webm', workDir: '/work/one' }),
    runtime.transcribe({ filePath: '/two.webm', workDir: '/work/two' }),
  ]);
  assert.equal(cudaProbes, 1);
  assert.deepEqual(ingests.map(({ device, computeType }) => ({ device, computeType })), [
    { device: 'cuda', computeType: 'float16' },
    { device: 'cuda', computeType: 'float16' },
  ]);
});

test('abort прерывает ожидание lazy CUDA probe до запуска ingest', async () => {
  const probe = deferred();
  const started = deferred();
  let ingests = 0;
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    settings: { device: 'auto' },
    autoCudaProbeTimeoutMs: 5_000,
    deps: readyDeps({
      async runCudaCanary() {
        started.resolve();
        return probe.promise;
      },
      async ingestRecording() {
        ingests += 1;
        return { transcript: { segments: [] } };
      },
    }),
  });
  const abort = new AbortController();
  const transcribe = runtime.transcribe({
    filePath: '/audio.webm',
    workDir: '/work',
    signal: abort.signal,
  });
  await started.promise;
  abort.abort();
  await assert.rejects(transcribe, (error) => error.name === 'AbortError');
  assert.equal(ingests, 0);
  probe.resolve({ state: 'ready', reason: null });
});

test('applyRuntimeSettings запускает readiness, но не CUDA canary', async () => {
  let canaries = 0;
  let scans = 0;
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    deps: readyDeps({
      probeSpeechModelCache: async () => {
        scans += 1;
        return models(['medium']);
      },
      runCudaCanary: async () => {
        canaries += 1;
        return { state: 'ready', reason: null };
      },
    }),
  });

  runtime.applyRuntimeSettings({ engine: 'browser', quality: 'balanced' });
  const snapshot = await runtime.publicSnapshotAsync();
  assert.equal(snapshot.local.ready, true);
  assert.equal(scans, 1);
  assert.equal(canaries, 0);
});

test('request settings проверяются против своей модели, а не cached runtime settings', async () => {
  let ingests = 0;
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    settings: { quality: 'balanced' },
    deps: readyDeps({
      probeSpeechModelCache: async () => models(['medium']),
      ingestRecording: async () => {
        ingests += 1;
        return { transcript: { segments: [] } };
      },
    }),
  });

  assert.equal((await runtime.publicSnapshotAsync()).local.ready, true);
  await assert.rejects(
    runtime.transcribe({
      filePath: '/audio.webm',
      workDir: '/work',
      settings: { quality: 'fast', model: 'small' },
    }),
    (error) => error.code === 'speech_model_missing' && /модель small/.test(error.message),
  );
  assert.equal(ingests, 0);
});

test('warmup возвращает model_missing до spawn, а сбой cache probe остаётся unavailable', async () => {
  let spawned = 0;
  const missing = new SpeechRuntime({
    mediaDir: '/state/media',
    deps: readyDeps({
      probeSpeechModelCache: async () => models(['medium']),
      createWarmupProcess: async () => {
        spawned += 1;
        throw new Error('не должен запускаться');
      },
    }),
  });
  await assert.rejects(
    missing.warmup({ settings: { model: 'small' } }),
    (error) => error.code === 'speech_model_missing' && /small/.test(error.message),
  );
  assert.equal(spawned, 0);

  const brokenProbe = new SpeechRuntime({
    mediaDir: '/state/media',
    deps: readyDeps({
      probeSpeechModelCache: async () => { throw new Error('probe crashed'); },
    }),
  });
  await assert.rejects(
    brokenProbe.transcribe({ filePath: '/audio.webm', workDir: '/work' }),
    (error) => error.code === 'speech_unavailable' && /кэша моделей/.test(error.message),
  );
});

test('capabilities reconcile detached model jobs для любого runtime consumer', async () => {
  let cached = false;
  let reconciliations = 0;
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    settings: { model: 'medium' },
    deps: readyDeps({
      probeSpeechModelCache: async () => models(cached ? ['medium'] : []),
    }),
  });
  runtime.attachModelJobs({
    async reconcileCompleted() {
      reconciliations += 1;
      cached = true;
      runtime.invalidateCapabilities();
      return 1;
    },
  });

  const capabilities = await runtime.capabilities();
  assert.equal(reconciliations, 1);
  assert.equal(capabilities.models.find((model) => model.modelId === 'medium').cached, true);
  assert.equal(capabilities.local.ready, true);
});

test('warmup и transcribe подбирают detached download без polling capabilities', async () => {
  function coldRuntime(extra = {}) {
    let cached = false;
    let reconciliations = 0;
    const runtime = new SpeechRuntime({
      mediaDir: '/state/media',
      settings: { model: 'medium', device: 'cpu' },
      deps: readyDeps({
        probeSpeechModelCache: async () => models(cached ? ['medium'] : []),
        ...extra,
      }),
    });
    runtime.attachModelJobs({
      async reconcileCompleted() {
        reconciliations += 1;
        cached = true;
        runtime.invalidateCapabilities();
        return 1;
      },
    });
    return { runtime, reconciliations: () => reconciliations };
  }

  const warm = coldRuntime({
    async createWarmupProcess({ nonce }) {
      return {
        identity: { pid: 123, starttime: '456', cmdline: ['worker', nonce], nonce },
        async cancel() {},
      };
    },
  });
  assert.equal((await warm.runtime.publicSnapshotAsync()).local.ready, false);
  const warmed = await warm.runtime.warmup({ settings: { model: 'medium', device: 'cpu' } });
  assert.equal(warm.reconciliations(), 1);
  await warm.runtime.cancelWarmup(warmed.warmupId);

  let ingests = 0;
  const direct = coldRuntime({
    async ingestRecording() {
      ingests += 1;
      return { transcript: { segments: [] } };
    },
  });
  assert.equal((await direct.runtime.publicSnapshotAsync()).local.ready, false);
  await direct.runtime.transcribe({ filePath: '/audio.webm', workDir: '/work' });
  assert.equal(direct.reconciliations(), 1);
  assert.equal(ingests, 1);
});

test('refresh нового generation не разделяет и не перезаписывается старым inflight', async () => {
  const preflights = [];
  const modelProbes = [];
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    settings: { quality: 'balanced' },
    deps: {
      preflight() {
        const current = deferred();
        preflights.push(current);
        return current.promise;
      },
      probeSpeechModelCache() {
        const current = deferred();
        modelProbes.push(current);
        return current.promise;
      },
      runCudaCanary: async () => ({ state: 'no_device', reason: 'нет GPU' }),
    },
  });

  const oldProbe = runtime.capabilities();
  await new Promise((resolve) => setImmediate(resolve));
  const freshProbe = runtime.refreshCapabilities();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preflights.length, 2);
  assert.equal(modelProbes.length, 2);

  preflights[1].resolve({ ok: true, checks: [{ name: 'новое', ok: true }], venvPython: '/new' });
  modelProbes[1].resolve(models(['medium']));
  const fresh = await freshProbe;
  assert.equal(fresh.local.ready, true);

  preflights[0].resolve({ ok: false, checks: [{ name: 'старое', ok: false }], venvPython: '/old' });
  modelProbes[0].resolve(models([]));
  const old = await oldProbe;
  assert.equal(old.local.ready, false);
  assert.equal(await runtime.capabilities(), fresh);
  assert.equal(runtime.publicSnapshot().local.ready, true);
});

test('detached video сохраняет device:auto для worker retry', async () => {
  let job;
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    settings: { device: 'auto' },
    deps: readyDeps({
      runCudaCanary: async () => ({ state: 'ready', reason: null }),
      startIngestJob(value) {
        job = value;
        return { jobId: 'job-1' };
      },
      mkdirSync: () => {},
      mkdtempSync: () => '/work/video',
    }),
  });
  await runtime.capabilities();
  runtime.startVideoJob({ filePath: '/video.mp4', settings: { device: 'auto' } });
  assert.deepEqual({ device: job.speech.device, computeType: job.speech.computeType }, {
    device: 'auto',
    computeType: 'auto',
  });
});
