import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { ensureTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import { startDeepSeekLoopback, writeDeepSeekLoopbackOverlay } from '../helpers/deepseekLoopback.mts';
import { runDeepSeekWebTurn } from '../../server/src/lib/deepseek/webRuntime.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { chatHomeFor } from '../../server/src/lib/deepseek/env.ts';
import { readDeepSeekArtifact } from '../../server/src/lib/deepseek/runtimeArtifact.ts';
import { activateDeepSeekGeneration, publishDeepSeekGeneration }
  from '../../tools/deepseekRuntimePublication.ts';
import { forkDeepSeekHome } from '../../tools/deepseekHomeFork.ts';

/**
 * B сохраняет настоящий compiled runtime A, добавляя собственный host resource в identity.
 * Оба поколения имеют реальный SDK и одинаковый доказанный journal codec v3.
 */
async function variant(source, destination) {
  await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });

  const file = path.join(destination, 'runtime.json');
  const metadata = JSON.parse(await fs.readFile(file, 'utf8'));

  await fs.writeFile(path.join(destination, 'rollback-fixture.txt'), 'generation-B', { mode: 0o644 });
  metadata.payload['rollback-fixture.txt'] = createHash('sha256')
    .update(`420:${Buffer.from('generation-B').toString('base64')}`).digest('hex');
  metadata.payload = Object.fromEntries(Object.entries(metadata.payload)
    .sort(([a], [b]) => a.localeCompare(b, 'en')));
  metadata.inputIdentity.composition += ':rollback-fixture-B';
  metadata.buildId = createHash('sha256').update(JSON.stringify({
    inputIdentity: metadata.inputIdentity,
    payload: metadata.payload,
  })).digest('hex');
  metadata.runtimeVersion = `${metadata.source.version}.cockpit.b${metadata.buildId.slice(0, 16)}`;
  await fs.writeFile(file, JSON.stringify(metadata));

  return readDeepSeekArtifact(destination).artifact;
}

/**
 * Журналы перечисляются только в home собственной fixture, без production data.
 * Bytes используются для проверки refusal без изменения оригинальной записи B.
 */
async function journals(root, relative = '') {
  const files = [];

  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);

    if (entry.isDirectory()) {
      files.push(...await journals(root, name));
    } else if (/\.jsonl(?:\.zstd)?$/u.test(name)) {
      files.push(name);
    }
  }

  return files;
}

test('настоящий B сохраняет журнал, A продолжает совместимую копию и отвергает будущий формат', async (t) => {
  const artifact = await ensureTestDeepSeekArtifact();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-rollback-'));
  const runtimeRoot = path.join(root, 'runtime');
  const homeRoot = path.join(root, 'homes');
  const a = readDeepSeekArtifact(artifact).artifact;
  const launches = [];
  let release;
  let entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const firstHttp = new Promise((resolve) => {
    entered = resolve;
  });
  const mock = await startDeepSeekLoopback({ respond: async (_payload, index) => {
    if (index === 0) {
      entered();
      await held;
    }

    return { deltas: [{ content: 'rollback-memory' }], finishReason: 'stop' };
  } });

  t.after(async () => {
    release();
    await mock.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  await publishDeepSeekGeneration(artifact, runtimeRoot);

  const config = {
    deepseekRuntimeMode: 'embedded',
    deepseekGenerationRoot: runtimeRoot,
    deepseekRuntimeHome: homeRoot,
    deepseekBin: '/absent/dsh',
  };
  // Запуск использует выбранный runtime и original overlay, меняя только loopback endpoint.
  // Профиль, journal backend, hooks и sandbox остаются настоящими.
  const run = (chatKey, extra = {}) => runDeepSeekWebTurn({
    config,
    cwd: root,
    projectRoot: root,
    chatKey,
    message: 'rollback-fixture-prompt',
    model: '["deepseek-official","deepseek-v4-flash"]',
    effort: 'off',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      DEEPSEEK_API_KEY: 'cockpit-loopback-only',
    },
    signal: AbortSignal.timeout(45_000),
    startServer: async (options) => {
      const launchDir = path.dirname(options.overlayPath);
      const original = await fs.readFile(options.overlayPath, 'utf8');
      const patch = await writeDeepSeekLoopbackOverlay({
        root: launchDir,
        artifact: options.runtime.generationDir,
        endpoint: mock.endpoint,
        document: path.join(launchDir, 'native-settings.yaml'),
      });
      const combined = path.join(launchDir, 'combined.yml');

      await fs.writeFile(combined, original + await fs.readFile(patch, 'utf8'));
      launches.push({ buildId: options.runtime.buildId, home: options.env.DSH_HOME });

      return startDeepSeekServer({ ...options, overlayPath: combined });
    },
    ...extra,
  });
  const first = run('running-A');

  await firstHttp;

  const candidateB = path.join(root, 'candidate-B');
  const b = await variant(artifact, candidateB);

  await publishDeepSeekGeneration(candidateB, runtimeRoot);

  const second = await run('written-B');

  release();
  await first;
  assert.deepEqual(launches.slice(0, 2).map((launch) => launch.buildId), [a.buildId, b.buildId]);
  assert.notEqual(launches[0].home, launches[1].home);

  const sourceHome = launches[1].home;
  const logs = await journals(sourceHome);
  const originalBytes = await Promise.all(logs.map((name) => fs.readFile(path.join(sourceHome, name))));

  assert.ok(logs.length);
  await activateDeepSeekGeneration(runtimeRoot, a.buildId);

  const copied = chatHomeFor(path.join(homeRoot, 'generations', a.buildId), 'compatible-copy');

  await forkDeepSeekHome(sourceHome, copied, path.join(runtimeRoot, 'builds', a.buildId));

  const resumed = await run('compatible-copy', { sessionId: second.sessionId });

  assert.equal(resumed.sessionId, second.sessionId);
  assert.equal(mock.payloads.at(-1).messages.some((message) => message.content === 'rollback-memory'), true);

  const future = chatHomeFor(path.join(homeRoot, 'generations', a.buildId), 'future-copy');

  await forkDeepSeekHome(sourceHome, future, path.join(runtimeRoot, 'builds', a.buildId));

  const sourceLog = path.join(future, logs[0]);
  const futureLog = sourceLog.replace(/\.v3\.jsonl/u, '.v99.jsonl');

  assert.notEqual(sourceLog, futureLog);
  await fs.rename(sourceLog, futureLog);

  const refusedBytes = await fs.readFile(futureLog);
  const requests = mock.payloads.length;

  await assert.rejects(run('future-copy', { sessionId: second.sessionId }));
  assert.equal(mock.payloads.length, requests);
  assert.deepEqual(await fs.readFile(futureLog), refusedBytes);

  const after = await Promise.all(logs.map((name) => fs.readFile(path.join(sourceHome, name))));

  assert.deepEqual(after, originalBytes);
  await assert.rejects(forkDeepSeekHome(sourceHome, copied, path.join(runtimeRoot, 'builds', a.buildId)));
});
