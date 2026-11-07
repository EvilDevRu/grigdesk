import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { probeDeepSeekBinary } from '../../server/src/lib/deepseek/binaryProbe.ts';
import { writeDeepSeekBinaryStub as executable } from '../helpers/deepseekBinaryStub.mts';

test('штатный бинарник contract 1 даёт descriptor с cache и ожидаемым packageId', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'binary-descriptor-'));
  const binary = path.join(root, 'наш executable');
  const cache = path.join(root, 'выбранный cache');
  const info = runtimeInfoFixture();

  info.workerNode.abi = process.versions.modules === '137' ? '127' : '137';
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(binary, `#!${process.execPath}\n`
    + `process.stdout.write(${JSON.stringify(JSON.stringify(info))});\n`, { mode: 0o755 });

  const value = await resolveDeepSeekRuntimeAsync({
    deepseekRuntimeMode: 'binary',
    deepseekBin: binary,
    deepseekCacheDir: cache,
  });

  assert.equal(value.kind, 'binary');
  assert.equal(value.command, binary);
  assert.deepEqual(value.prefixArgs, ['--expect-package-id', info.packageId, '--cache-dir', cache]);
  assert.equal(value.buildId, info.buildId);
  assert.equal(value.generationDir, null);
  assert.deepEqual(value.capabilities, info.capabilities);
  assert.equal(value.metadata.workerNode.abi, info.workerNode.abi);
  assert.notEqual(value.metadata.workerNode.abi, process.versions.modules);
  assert.equal(value.identity, `deepseek-package:${info.packageId}`);
  await assert.rejects(fs.access(cache), { code: 'ENOENT' });
});

test('явный override сохраняет settings capabilities и принимает новую upstream version', async (t) => {
  const info = { ...runtimeInfoFixture(), upstreamVersion: '10.0.0-compatible' };
  const { binary, root } = await executable(t,
    `process.stdout.write(${JSON.stringify(JSON.stringify(info))});`);
  const value = await resolveDeepSeekRuntimeAsync({
    deepseekRuntimeMode: 'embedded',
    deepseekBinOverride: binary,
    deepseekCacheDir: path.join(root, 'cache'),
  });

  assert.equal(value.kind, 'binary');
  assert.equal(value.upstreamVersion, info.upstreamVersion);
  assert.equal(value.capabilities.settingsAcp, true);
});

test('stock dsh по override отвергается с командой установки, без PATH fallback', async (t) => {
  const { binary, root } = await executable(t,
    'process.stderr.write("unknown --runtime-info PRIVATE_SENTINEL"); process.exit(2);');

  await assert.rejects(resolveDeepSeekRuntimeAsync({
    deepseekBinOverride: binary,
    deepseekCacheDir: path.join(root, 'cache'),
  }), (error) => {
    assert.equal(error.code, 'deepseek_binary_unsupported');
    assert.match(error.message, /npm --prefix deepseek run install:binary/u);
    assert.doesNotMatch(error.message, /PRIVATE_SENTINEL|unknown --runtime-info/u);

    return true;
  });
  await assert.rejects(resolveDeepSeekRuntimeAsync({ deepseekBinOverride: 'dsh' }), {
    code: 'deepseek_binary_unsupported',
  });
});

test('metadata различает missing, права, timeout, лимит вывода, JSON и host contract', async (t) => {
  const cases = [
    ['missing', '', 'deepseek_binary_missing'],
    ['permissions', 'process.stdout.write("{}");', 'deepseek_binary_not_executable'],
    ['timeout', 'setInterval(() => {}, 1000);', 'deepseek_binary_timeout'],
    ['output', 'process.stdout.write("x".repeat(70000));', 'deepseek_binary_output_limit'],
    ['json', 'process.stdout.write("PRIVATE_SENTINEL");', 'deepseek_binary_metadata_invalid'],
    ['contract', `process.stdout.write(${JSON.stringify(JSON.stringify({
      ...runtimeInfoFixture(), hostContract: 2,
    }))});`, 'deepseek_binary_unsupported'],
  ];

  for (const [kind, body, code] of cases) {
    const { binary } = await executable(t, body, kind === 'permissions' ? 0o644 : 0o755);

    if (kind === 'missing') {
      await fs.unlink(binary);
    }

    await assert.rejects(probeDeepSeekBinary(binary, { timeoutMs: 1000 }), (error) => {
      assert.equal(error.code, code, kind);
      assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/u);

      return true;
    });
  }
});

test('metadata argv не содержит prefix, env не содержит HOME, ключи и loader inputs', async (t) => {
  const info = runtimeInfoFixture();
  const { root, binary } = await executable(t, '');
  const trace = path.join(root, 'probe.json');
  const preload = path.join(root, 'preload.cjs');
  const marker = path.join(root, 'preload-ran');

  await fs.writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  await fs.writeFile(binary, `#!${process.execPath}\n`
    + `require('node:fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify({\n`
    + '  args: process.argv.slice(2),\n'
    + '  inherited: ["HOME", "GRIGDESK_HOME", "DEEPSEEK_API_KEY", "ZAI_API_KEY", "NODE_OPTIONS"]\n'
    + '    .filter((key) => key in process.env),\n'
    + '}));\n'
    + `process.stdout.write(${JSON.stringify(JSON.stringify(info))});\n`);

  const previous = { NODE_OPTIONS: process.env.NODE_OPTIONS, ZAI_API_KEY: process.env.ZAI_API_KEY };

  process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  process.env.ZAI_API_KEY = 'synthetic-foreign-key';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  await resolveDeepSeekRuntimeAsync({
    deepseekRuntimeMode: 'binary',
    deepseekBin: binary,
    deepseekCacheDir: path.join(root, 'cache'),
  });
  assert.deepEqual(JSON.parse(await fs.readFile(trace, 'utf8')), {
    args: ['--runtime-info', '--json'],
    inherited: [],
  });
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});
