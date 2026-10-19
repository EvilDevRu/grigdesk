import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { ensureTestDeepSeekBinary } from '../helpers/deepseekBinary.mts';
import { startDeepSeekLoopback, writeDeepSeekLoopbackOverlay } from '../helpers/deepseekLoopback.mts';
import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { buildDeepSeekChildEnv } from '../../server/src/lib/deepseek/env.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { startDeepSeekAcpSettings } from '../../server/src/lib/deepseek/nativeSettingsRpc.ts';
import { readDeepSeekCatalog } from '../../server/src/lib/deepseek/catalog.ts';
import { runDeepSeekServerTurn } from '../../server/src/lib/deepseek/serverTurn.ts';
import { dataPath } from '../../shared/runtime/dataHome.ts';

const exec = promisify(execFile);

test('verify, web/ACP settings, catalog и чат распаковывают ELF только в server-owned cache', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'binary cache roots '));
  const parentHome = path.join(root, 'parent-home');
  const dataHome = path.join(root, 'data-home');
  const cache = path.join(root, 'выбранный cache');
  const dshHome = path.join(dataHome, 'private-home');
  const workspace = path.join(root, 'project');
  const poison = path.join(root, 'preload.cjs');
  const ran = path.join(root, 'preload-ran');
  const mock = await startDeepSeekLoopback();

  t.after(async () => {
    await mock.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(parentHome);
  await fs.mkdir(dshHome, { recursive: true });
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(parentHome, 'sentinel'), 'unchanged');
  await fs.writeFile(poison, `require('node:fs').writeFileSync(${JSON.stringify(ran)}, 'ran');`);

  const config = {
    deepseekRuntimeMode: 'binary',
    deepseekBin: candidate.binary,
    deepseekCacheDir: cache,
    deepseekRuntimeHome: path.join(dataHome, 'runtime'),
  };
  const source = {
    PATH: '',
    HOME: parentHome,
    GRIGDESK_HOME: dataHome,
    TMPDIR: root,
    DEEPSEEK_API_KEY: 'synthetic-loopback-key',
    ZAI_API_KEY: 'synthetic-foreign-key',
    NODE_OPTIONS: `--require ${JSON.stringify(poison)}`,
  };
  const env = buildDeepSeekChildEnv({ source, dshHome });
  const runtime = await resolveDeepSeekRuntimeAsync(config);

  assert.equal(runtime.kind, 'binary');
  assert.equal('ZAI_API_KEY' in env, false);
  assert.equal('NODE_OPTIONS' in env, false);
  await assert.rejects(fs.access(cache), { code: 'ENOENT' });

  const verified = await exec(runtime.command, [...runtime.prefixArgs, '--verify', '--json'], {
    cwd: workspace,
    env,
    timeout: 120000,
  });

  assert.equal(JSON.parse(verified.stdout).verified, true);
  assert.equal(verified.stderr, '');

  const generation = path.join(cache, 'packages', candidate.info.packageId, 'generation');
  const document = path.join(dshHome, 'settings.yaml');

  await fs.writeFile(document, '{}\n');

  const overlayPath = await writeDeepSeekLoopbackOverlay({
    root,
    artifact: generation,
    endpoint: mock.endpoint,
    document,
  });
  const web = await startDeepSeekServer({
    bin: candidate.binary,
    runtime,
    overlayPath,
    cwd: workspace,
    env,
  });

  try {
    const description = await web.client.rpc('settings/describe');

    assert.ok(description.namespaces.length > 0, 'Работает настоящий web settings RPC');
  } finally {
    await web.stop();
  }

  const acp = await startDeepSeekAcpSettings({
    runtime,
    overlayPath,
    cwd: workspace,
    env,
  });

  try {
    const description = await acp.client.rpc('settings/describe');

    assert.ok(description.namespaces.length > 0, 'Работает настоящий ACP settings RPC');
  } finally {
    await acp.stop();
  }

  const catalog = await readDeepSeekCatalog({ config, env: source });

  assert.ok(catalog.models.length > 0);
  assert.equal(mock.payloads.length, 0, 'Metadata/settings/catalog не вызывают модель');

  const result = await runDeepSeekServerTurn({
    bin: candidate.binary,
    runtime,
    overlayPath,
    cwd: workspace,
    env,
    message: 'Проверь выбранный cache root.',
    model: '["deepseek-official","deepseek-v4-flash"]',
    effort: 'off',
    signal: AbortSignal.timeout(60000),
  });

  assert.equal(result.reply, 'loopback-ok');
  assert.equal(mock.payloads.length, 1);
  assert.deepEqual(await fs.readdir(path.join(cache, 'packages')), [candidate.info.packageId]);
  await assert.rejects(fs.access(dataPath(dataHome, 'deepseekRuntime')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(parentHome), ['sentinel']);
  assert.equal(await fs.readFile(path.join(parentHome, 'sentinel'), 'utf8'), 'unchanged');
  await assert.rejects(fs.access(ran), { code: 'ENOENT' });
});
