import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  MODEL_CACHE_PROBE_PY,
  SPEECH_MODEL_CATALOG,
  SpeechRuntime,
  inspectSpeechModelCache,
  probeSpeechModelCache,
  runCudaCanary,
} from '../../server/src/lib/speech/index.ts';

function snapshotPath(hfDir, repo, revision) {
  return path.join(
    hfDir,
    'hub',
    `models--${repo.replaceAll('/', '--')}`,
    'snapshots',
    revision,
  );
}

function fakeModels(cachedIds) {
  return Object.values(SPEECH_MODEL_CATALOG).map((model) => ({
    modelId: model.modelId,
    repo: model.repo,
    revision: model.revision,
    cached: cachedIds.includes(model.modelId),
    sizeMb: cachedIds.includes(model.modelId) ? 123.4 : 0,
  }));
}

test('model cache учитывает точную revision, обязательные файлы и фактический размер', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-model-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const medium = SPEECH_MODEL_CATALOG.medium;
  const mediumSnapshot = snapshotPath(root, medium.repo, medium.revision);
  mkdirSync(mediumSnapshot, { recursive: true });
  writeFileSync(path.join(mediumSnapshot, 'config.json'), '{}');
  writeFileSync(path.join(mediumSnapshot, 'model.bin'), '');
  truncateSync(path.join(mediumSnapshot, 'model.bin'), 3 * 1024 * 1024);
  writeFileSync(path.join(mediumSnapshot, 'tokenizer.json'), '');
  truncateSync(path.join(mediumSnapshot, 'tokenizer.json'), 512 * 1024);

  const small = SPEECH_MODEL_CATALOG.small;
  const wrongRevision = snapshotPath(root, small.repo, '0'.repeat(40));
  mkdirSync(wrongRevision, { recursive: true });
  writeFileSync(path.join(wrongRevision, 'config.json'), '{}');
  writeFileSync(path.join(wrongRevision, 'model.bin'), 'не та ревизия');

  const large = SPEECH_MODEL_CATALOG['large-v3'];
  const incomplete = snapshotPath(root, large.repo, large.revision);
  mkdirSync(incomplete, { recursive: true });
  writeFileSync(path.join(incomplete, 'config.json'), '{}');

  const unverified = inspectSpeechModelCache({ mediaHfDir: root });
  assert.equal(unverified.find((model) => model.modelId === 'medium').cached, false);
  const models = inspectSpeechModelCache({
    mediaHfDir: root,
    verifiedSnapshots: [{ modelId: 'medium', cached: true, snapshotPath: mediumSnapshot }],
  });
  const byId = Object.fromEntries(models.map((model) => [model.modelId, model]));
  assert.equal(byId.medium.cached, true);
  assert.equal(byId.medium.sizeMb, 3.5);
  assert.equal(byId.small.cached, false, 'другая snapshot revision не считается моделью каталога');
  assert.equal(byId['large-v3'].cached, false, 'частичный snapshot без model.bin не готов');
  assert.equal(byId['large-v3'].sizeMb, 0);
});

test('alias-репозиторий turbo распознаётся только с catalog revision', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-model-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const turbo = SPEECH_MODEL_CATALOG['large-v3-turbo'];
  const snapshot = snapshotPath(root, turbo.aliases[0], turbo.revision);
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(path.join(snapshot, 'config.json'), '{}');
  writeFileSync(path.join(snapshot, 'tokenizer.json'), '{}');
  writeFileSync(path.join(snapshot, 'model.bin'), 'weights');
  const status = inspectSpeechModelCache({
    mediaHfDir: root,
    verifiedSnapshots: [{ modelId: 'large-v3-turbo', cached: true, snapshotPath: snapshot }],
  })
    .find((model) => model.modelId === 'large-v3-turbo');
  assert.equal(status.cached, true);
});

test('Python cache probe пропускает partial canonical и выбирает полный pinned alias', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-model-alias-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonical = path.join(root, 'canonical');
  const alias = path.join(root, 'alias');
  mkdirSync(canonical, { recursive: true });
  mkdirSync(alias, { recursive: true });
  writeFileSync(path.join(canonical, 'config.json'), '{}');
  for (const name of ['config.json', 'tokenizer.json', 'model.bin']) {
    writeFileSync(path.join(alias, name), name);
  }
  const turbo = SPEECH_MODEL_CATALOG['large-v3-turbo'];
  const source = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('cache_probe', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
calls = []
def snapshot_download(**kwargs):
    calls.append(kwargs)
    return sys.argv[2] if kwargs['repo_id'].startswith('dropbox-dash/') else sys.argv[3]
model = json.loads(sys.argv[4])
print(json.dumps({'result': module.inspect_model(snapshot_download, model), 'calls': calls}))
`;
  const run = spawnSync('python3', [
    '-c', source, MODEL_CACHE_PROBE_PY, canonical, alias,
    JSON.stringify({
      modelId: turbo.modelId,
      repo: turbo.repo,
      revision: turbo.revision,
      aliases: turbo.aliases,
    }),
  ], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.result.cached, true);
  assert.equal(payload.result.snapshotPath, alias);
  assert.equal(payload.result.resolvedRepo, turbo.aliases[0]);
  assert.deepEqual(payload.calls.map((call) => call.revision), [turbo.revision, turbo.revision]);
  assert.deepEqual(payload.calls.map((call) => call.local_files_only), [true, true]);
});

test('Python cache probe не бракует полный pinned snapshot из-за orphan incomplete', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-model-orphan-incomplete-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = path.join(root, 'model', 'snapshots', 'revision');
  const blobs = path.join(root, 'model', 'blobs');
  mkdirSync(snapshot, { recursive: true });
  mkdirSync(blobs, { recursive: true });
  for (const name of ['config.json', 'tokenizer.json']) {
    writeFileSync(path.join(snapshot, name), name);
  }
  // Такую пару оставил живой download: финальный blob уже на месте, а temp
  // отменённого worker-а больше ни на что не ссылается.
  writeFileSync(path.join(blobs, 'weights'), 'готовые веса');
  symlinkSync('../../blobs/weights', path.join(snapshot, 'model.bin'));
  writeFileSync(path.join(blobs, 'weights.1234abcd.incomplete'), '');
  const medium = SPEECH_MODEL_CATALOG.medium;
  const source = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('cache_probe', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def snapshot_download(**_kwargs):
    return sys.argv[2]
model = json.loads(sys.argv[3])
print(json.dumps(module.inspect_model(snapshot_download, model)))
`;
  const model = JSON.stringify({
    modelId: medium.modelId,
    repo: medium.repo,
    revision: medium.revision,
    aliases: medium.aliases,
  });
  const probe = () => {
    const run = spawnSync('python3', [
      '-c', source, MODEL_CACHE_PROBE_PY, snapshot, model,
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  const result = probe();
  assert.equal(result.cached, true);
  assert.equal(result.snapshotPath, snapshot);

  writeFileSync(path.join(blobs, 'missing.87654321.incomplete'), 'часть другого blob');
  const partial = probe();
  assert.equal(partial.cached, false);
  assert.match(partial.reason, /без финального файла/);
});

test('capabilities связывает local.ready с текущей dictation-моделью и кэширует probe', async () => {
  let preflights = 0;
  let modelScans = 0;
  let cudaProbes = 0;
  const canaryModels = [];
  let cachedIds = ['medium'];
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    mediaHfDir: '/state/hf',
    pythonPath: '/state/venv/bin/python',
    settings: { quality: 'fast' },
    lastDictionaryMeasure: { tokens: 12, truncated: false, measuredAt: 100 },
    deps: {
      preflight() {
        preflights += 1;
        return { ok: true, checks: [{ name: 'окружение', ok: true, fix: '' }], venvPython: '/venv/python' };
      },
      inspectSpeechModelCache() {
        modelScans += 1;
        return fakeModels(cachedIds);
      },
      runCudaCanary({ model }) {
        cudaProbes += 1;
        canaryModels.push(model?.modelId || null);
        return { state: 'missing_library', reason: 'libcublas.so.12 не найден' };
      },
    },
  });

  const first = await runtime.capabilities();
  assert.equal(first.local.ready, false);
  assert.match(first.local.reason, /модель small/);
  assert.equal(first.ok, false);
  assert.deepEqual(first.cuda, { state: 'missing_library', reason: 'libcublas.so.12 не найден' });
  assert.deepEqual(first.languages, ['ru', 'en', 'auto']);
  assert.deepEqual(first.lastDictionaryMeasure, { tokens: 12, truncated: false, measuredAt: 100 });
  assert.deepEqual(first.resident, {
    supported: false,
    loaded: false,
    model: null,
    device: null,
    memMb: null,
    unloadAtSec: null,
  });
  assert.equal(await runtime.capabilities(), first);
  assert.deepEqual([preflights, modelScans, cudaProbes], [1, 1, 1]);

  cachedIds = ['small', 'medium'];
  const refreshed = await runtime.refreshCapabilities();
  assert.equal(refreshed.local.ready, true);
  assert.deepEqual([preflights, modelScans, cudaProbes], [2, 2, 2]);
  assert.deepEqual(canaryModels, ['medium', 'small']);
});

test('applyRuntimeSettings инвалидирует snapshot и проверяет новую explicit model', async () => {
  let scans = 0;
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    settings: { quality: 'balanced' },
    deps: {
      preflight: () => ({ ok: true, checks: [], venvPython: '/venv/python' }),
      inspectSpeechModelCache() {
        scans += 1;
        return fakeModels(['medium', 'large-v3']);
      },
      runCudaCanary: () => ({ state: 'no_device', reason: 'GPU нет' }),
    },
  });
  assert.equal((await runtime.capabilities()).local.ready, true);
  runtime.applyRuntimeSettings({ quality: 'fast', model: 'large-v3' });
  assert.equal((await runtime.capabilities()).local.ready, true);
  assert.equal(scans, 2);
});

test('CUDA canary нормализует JSON subprocess без наличия GPU в тесте', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-cuda-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pythonPath = path.join(root, 'venv', 'bin', 'python');
  mkdirSync(path.dirname(pythonPath), { recursive: true });
  writeFileSync(pythonPath, 'fake');
  let spawnArgs;
  const result = await runCudaCanary({
    pythonPath,
    env: { HF_HOME: '/state/hf' },
    model: 'medium',
    async run(cmd, args, options) {
      spawnArgs = { cmd, args, options };
      return {
        status: 0,
        stdout: JSON.stringify({ state: 'no_device', reason: 'нет устройства' }),
        stderr: '',
      };
    },
  });
  assert.equal(spawnArgs.cmd, pythonPath);
  assert.deepEqual(spawnArgs.args.slice(-4), [
    '--model-repo', SPEECH_MODEL_CATALOG.medium.repo,
    '--model-revision', SPEECH_MODEL_CATALOG.medium.revision,
  ]);
  assert.equal(spawnArgs.options.env.HF_HOME, '/state/hf');
  assert.deepEqual(result, { state: 'no_device', reason: 'нет устройства' });

  const invalid = await runCudaCanary({
    pythonPath,
    run: async () => ({ status: 0, stdout: '{"state":"maybe"}', stderr: '' }),
  });
  assert.equal(invalid.state, 'probe_failed');

  await runCudaCanary({
    pythonPath,
    model: 'large-v3-turbo',
    run: async (_cmd, args) => {
      assert.deepEqual(args.slice(-6), [
        '--model-repo', SPEECH_MODEL_CATALOG['large-v3-turbo'].repo,
        '--model-revision', SPEECH_MODEL_CATALOG['large-v3-turbo'].revision,
        '--model-alias', SPEECH_MODEL_CATALOG['large-v3-turbo'].aliases[0],
      ]);
      return { status: 0, stdout: '{"state":"ready"}', stderr: '' };
    },
  });
});

test('Python model probe подтверждает путь, а Node считает размер только после него', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-hf-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pythonPath = path.join(root, 'venv', 'bin', 'python');
  mkdirSync(path.dirname(pythonPath), { recursive: true });
  writeFileSync(pythonPath, 'fake');
  const medium = SPEECH_MODEL_CATALOG.medium;
  const snapshot = snapshotPath(root, medium.repo, medium.revision);
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(path.join(snapshot, 'config.json'), '{}');
  writeFileSync(path.join(snapshot, 'tokenizer.json'), '{}');
  writeFileSync(path.join(snapshot, 'model.bin'), 'weights');
  let command;
  const models = await probeSpeechModelCache({
    pythonPath,
    mediaHfDir: root,
    env: { HF_HOME: root },
    async run(cmd, args, options) {
      command = { cmd, args, options };
      return {
        status: 0,
        stdout: JSON.stringify({
          models: [{ modelId: 'medium', cached: true, snapshotPath: snapshot }],
        }),
        stderr: '',
      };
    },
  });
  assert.equal(command.cmd, pythonPath);
  assert.equal(command.options.env.HF_HOME, root);
  assert.match(command.args.join(' '), new RegExp(medium.revision));
  assert.equal(models.find((model) => model.modelId === 'medium').cached, true);
});

test('production cache probe fail-closed отличает поломку диагностики от missing model', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-hf-probe-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pythonPath = path.join(root, 'venv', 'bin', 'python');
  mkdirSync(path.dirname(pythonPath), { recursive: true });
  writeFileSync(pythonPath, 'fake');

  const failures = [
    {
      result: { status: null, stdout: '', stderr: '', error: new Error('probe timeout') },
      pattern: /probe timeout/,
    },
    {
      result: { status: 7, stdout: '', stderr: 'hub cache crashed', error: null },
      pattern: /кодом 7.*hub cache crashed/,
    },
    {
      result: { status: 0, stdout: '{broken', stderr: '', error: null },
      pattern: /некорректный JSON/,
    },
    {
      result: { status: 0, stdout: '{}', stderr: '', error: null },
      pattern: /без массива models/,
    },
  ];
  for (const failure of failures) {
    await assert.rejects(
      probeSpeechModelCache({
        pythonPath,
        mediaHfDir: root,
        run: async () => failure.result,
      }),
      failure.pattern,
    );
  }

  let ingests = 0;
  const runtime = new SpeechRuntime({
    mediaDir: path.join(root, 'media'),
    mediaHfDir: root,
    pythonPath,
    settings: { model: 'medium', device: 'cpu' },
    deps: {
      preflight: async () => ({ ok: true, checks: [], venvPython: pythonPath }),
      probeSpeechModelCache: (options) => probeSpeechModelCache({
        ...options,
        run: async () => failures[1].result,
      }),
      async ingestRecording() { ingests += 1; return { transcript: { segments: [] } }; },
    },
  });
  await assert.rejects(
    runtime.transcribe({ filePath: '/audio.webm', workDir: '/work' }),
    (error) => error.code === 'speech_unavailable' && /кэша моделей/.test(error.message),
  );
  assert.equal(ingests, 0);
});

test('capabilities single-flight не блокирует publicSnapshot ожиданием canary', async () => {
  let releaseCanary;
  const canary = new Promise((resolve) => { releaseCanary = resolve; });
  let probes = 0;
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    deps: {
      preflight: async () => ({ ok: true, checks: [], venvPython: '/venv/python' }),
      probeSpeechModelCache: async () => fakeModels(['medium']),
      async runCudaCanary() {
        probes += 1;
        return canary;
      },
    },
  });
  const first = runtime.capabilities();
  const second = runtime.capabilities();
  const lightweight = runtime.publicSnapshot({ quality: 'balanced' });
  assert.equal(lightweight.local.ready, false);
  assert.equal(probes, 0, 'вызов вернулся до долгого canary');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1);
  releaseCanary({ state: 'ready', reason: null });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(probes, 1);
  assert.equal(runtime.publicSnapshot({ quality: 'balanced' }).local.ready, true);
});
