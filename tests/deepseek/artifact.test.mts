import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readWorkerArtifact } from '../../deepseek/src/runtime/artifact.ts';
import { readDeepSeekArtifactAsync } from '../helpers/deepseekLegacyArtifact.mts';
import { readDeepSeekArtifact } from '../../shared/node/deepSeekArtifact.ts';
import { isNodeVersionSupported } from '../../shared/runtime/nodeVersion.ts';
import { writeDeepSeekArtifactFixture } from '../helpers/deepSeekArtifactFixture.mts';

const worker = {
  nodeVersion: '24.21.0',
  platform: process.platform,
  arch: process.arch,
  nativeAbi: '137',
};

/**
 * Малое настоящее поколение получает identity выбранного worker без запуска модели.
 * Формула buildId сохраняется, поэтому отказ по ABI не маскируется повреждением metadata.
 */
async function fixture(t: test.TestContext, abi = worker.nativeAbi) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker artifact '));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const metadata = await writeDeepSeekArtifactFixture(root, 'worker-abi');

  metadata.inputIdentity.nativeAbi = abi;
  metadata.buildId = createHash('sha256').update(JSON.stringify({
    inputIdentity: metadata.inputIdentity,
    payload: metadata.payload,
  })).digest('hex');
  metadata.runtimeVersion = `${metadata.source.version}.grigdesk.b${metadata.buildId.slice(0, 16)}`;

  await fs.writeFile(path.join(root, 'runtime.json'), JSON.stringify(metadata));

  return { root, metadata };
}

test('generation Node 24 проверяется выбранным worker при другом ABI вызывающего Node', async (t) => {
  const { root } = await fixture(t);

  await assert.doesNotReject(() => readWorkerArtifact(root, worker));

  if (process.versions.modules !== worker.nativeAbi) {
    await assert.rejects(() => readDeepSeekArtifactAsync(root), {
      code: 'deepseek_runtime_incompatible',
    });
  }
});

test('прогретый integrity cache не разрешает неверный worker ABI, платформу или Node', async (t) => {
  const { root, metadata } = await fixture(t);
  const first = await readWorkerArtifact(root, worker);

  assert.equal(first.artifact.buildId, metadata.buildId);
  assert.equal(readDeepSeekArtifact(root, worker).artifact.buildId, metadata.buildId);

  for (const changed of [
    { ...worker, nativeAbi: 'wrong-abi' },
    { ...worker, platform: 'unsupported-platform' },
    { ...worker, arch: 'unsupported-arch' },
    { ...worker, nodeVersion: '23.0.0' },
    { ...worker, nodeVersion: '22.18.0' },
  ]) {
    await assert.rejects(() => readWorkerArtifact(root, changed), {
      code: 'deepseek_runtime_incompatible',
    });
    assert.throws(() => readDeepSeekArtifact(root, changed), {
      code: 'deepseek_runtime_incompatible',
    });
  }

  await assert.doesNotReject(() => readWorkerArtifact(root, worker));
});

test('повреждения dependency, mode и entry обнаруживаются после прогрева cache', async (t) => {
  const damages = [
    (root: string) => fs.writeFile(path.join(root, 'dependency.js'), 'corrupt'),
    (root: string) => fs.chmod(path.join(root, 'dependency.js'), 0o755),
    (root: string) => fs.unlink(path.join(root, 'entry.mjs')),
    (root: string) => fs.writeFile(path.join(root, 'extra.js'), 'unindexed'),
  ];

  for (const damage of damages) {
    const { root } = await fixture(t);

    await readWorkerArtifact(root, worker);
    await damage(root);
    await assert.rejects(() => readWorkerArtifact(root, worker), { code: 'deepseek_runtime_corrupt' });
    assert.throws(() => readDeepSeekArtifact(root, worker), { code: 'deepseek_runtime_corrupt' });
  }
});

test('относительная цепочка symlink наружу отвергается, внешний sentinel неизменён', async (t) => {
  const { root } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact sentinel '));

  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'sentinel'), 'untouched');
  await fs.symlink(path.relative(root, outside), path.join(root, 'first'));
  await fs.symlink('first/sentinel', path.join(root, 'second'));

  await assert.rejects(() => readWorkerArtifact(root, worker), { code: 'deepseek_runtime_corrupt' });
  assert.throws(() => readDeepSeekArtifact(root, worker), { code: 'deepseek_runtime_corrupt' });
  assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'untouched');
});

test('вне identity изменённый contract не принимается даже при целых файлах', async (t) => {
  const { root, metadata } = await fixture(t);

  metadata.capabilities = { ...metadata.capabilities, settingsAcp: false };
  await fs.writeFile(path.join(root, 'runtime.json'), JSON.stringify(metadata));

  await assert.rejects(() => readWorkerArtifact(root, worker), { code: 'deepseek_runtime_corrupt' });
  assert.throws(() => readDeepSeekArtifact(root, worker), { code: 'deepseek_runtime_corrupt' });
});

test('общая политика Node сохраняет минимум 22.19 и исключение Node 23', () => {
  for (const version of ['22.19.0', '22.22.1', '24.0.0', 'v24.21.0', '26.0.0-nightly']) {
    assert.equal(isNodeVersionSupported(version), true, version);
  }

  for (const version of ['18.20.0', '22.18.9', '23.99.0', 'invalid']) {
    assert.equal(isNodeVersionSupported(version), false, version);
  }
});
