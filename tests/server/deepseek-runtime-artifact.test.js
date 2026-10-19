import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { readDeepSeekSettings } from '../../server/src/lib/executorSettings/deepseek.ts';
import { deepSeekCatalogCacheKey } from '../../server/src/lib/deepseek/catalog.ts';

const artifactModule = await import('../helpers/deepseekLegacyArtifact.mts');
const processModule = await import('../../server/src/lib/deepseek/runtimeProcess.ts').catch(() => null);

/**
 * Малый артефакт использует настоящий формат identity и файловые хеши сборки.
 * Разные payload дают разные поколения при одинаковой upstream version.
 */
async function fixture(t, marker = 'A', changes = {}) {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek runtime '));
  const root = path.join(container, 'generation');

  t.after(() => fs.rm(container, { recursive: true, force: true }));
  await fs.mkdir(root);

  const contract = {
    format: 1,
    hostContract: 1,
    journalFormat: 1,
    source: {
      repository: 'https://github.com/deepseek-ai/deepseek-harness',
      commit: 'c291e7961a515f6d7af9304e7fd1d257929aef26',
      version: '0.1.5-rc.2',
    },
    nodeCompatibility: '^22.19.0 || >=24.0.0',
    entry: 'entry.mjs',
    capabilities: {
      web: true,
      acp: true,
      settingsWeb: true,
      settingsAcp: false,
    },
    ...changes,
  };
  const payload = {};

  for (const [name, content] of Object.entries({ 'entry.mjs': '// launcher\n', 'dependency.js': marker })) {
    await fs.writeFile(path.join(root, name), content, { mode: 0o644 });
    payload[name] = createHash('sha256')
      .update(`420:${Buffer.from(content).toString('base64')}`).digest('hex');
  }

  const inputIdentity = {
    contract,
    platform: process.platform,
    arch: process.arch,
    nativeAbi: process.versions.modules,
    composition: marker,
  };
  const buildId = createHash('sha256').update(JSON.stringify({ inputIdentity, payload })).digest('hex');
  const metadata = {
    ...contract,
    buildId,
    runtimeVersion: `${contract.source.version}.grigdesk.b${buildId.slice(0, 16)}`,
    inputIdentity,
    payload,
  };

  await fs.writeFile(path.join(root, 'runtime.json'), JSON.stringify(metadata));

  const info = {
    ...runtimeInfoFixture(),
    packageId: metadata.buildId,
    buildId: metadata.buildId,
    upstreamVersion: metadata.source.version,
    runtimeVersion: metadata.runtimeVersion,
    hostContract: metadata.hostContract,
  };
  const binary = path.join(container, 'deepseek');

  await fs.writeFile(binary, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(info))});`, {
    mode: 0o755,
  });

  return {
    root,
    metadata,
    binary,
    info,
  };
}

test('descriptor читает candidate при произвольном cwd и пробелах, не выбирает PATH dsh', async (t) => {
  assert.ok(artifactModule && processModule, 'Единый проверяющий descriptor пока отсутствует');

  const { root, metadata, binary, info } = await fixture(t);
  const descriptor = processModule.resolveDeepSeekRuntime({ deepseekBin: binary, deepseekCacheDir: root });

  assert.equal(descriptor.command, binary);
  assert.deepEqual(descriptor.prefixArgs, ['--expect-package-id', info.packageId, '--cache-dir', root]);
  assert.equal(descriptor.generationDir, null);
  assert.equal(descriptor.upstreamVersion, metadata.source.version);
  assert.equal(descriptor.buildId, metadata.buildId);
  assert.ok(Object.isFrozen(descriptor));
});

test('legacy integrity для cutover обнаруживает повреждение зависимости при прежнем entry', async (t) => {
  const { root } = await fixture(t);

  artifactModule.readDeepSeekArtifact(root);
  await fs.writeFile(path.join(root, 'dependency.js'), 'corrupt');
  assert.throws(() => artifactModule.readDeepSeekArtifact(root), { code: 'deepseek_runtime_corrupt' });
  await assert.rejects(artifactModule.readDeepSeekArtifactAsync(root), { code: 'deepseek_runtime_corrupt' });
});

test('host contract отвергается даже с целыми хешами; capabilities защищены identity', async (t) => {
  assert.ok(artifactModule && processModule, 'Контракт runtime пока не проверяется');

  const incompatible = await fixture(t, 'A', { hostContract: 999 });

  assert.throws(
    () => processModule.resolveDeepSeekRuntime({ deepseekBin: incompatible.binary }),
    { code: 'deepseek_binary_unsupported' },
  );

  const { root, metadata } = await fixture(t);

  metadata.capabilities.settingsAcp = true;
  await fs.writeFile(path.join(root, 'runtime.json'), JSON.stringify(metadata));
  assert.throws(
    () => artifactModule.readDeepSeekArtifact(root),
    { code: 'deepseek_runtime_corrupt' },
  );
});

test('смена выбранного binary сохраняет descriptor A и запрещает native план A на B', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, 'B');
  const a = processModule.resolveDeepSeekRuntime({ deepseekBin: first.binary });
  const b = processModule.resolveDeepSeekRuntime({ deepseekBin: second.binary });

  assert.notEqual(a.identity, b.identity);
  assert.equal(a.command, first.binary);
  assert.equal(a.prefixArgs[1], first.info.packageId);
  assert.throws(() => processModule.assertDeepSeekPreparedRuntime(b, { runtimeIdentity: a.identity }), {
    code: 'deepseek_runtime_changed',
  });
});

test('старые flags не выбирают PATH dsh; override требует автономную поставку', async (t) => {
  assert.ok(artifactModule && processModule, 'Выбор runtime пока отсутствует');

  const { root } = await fixture(t);

  assert.throws(
    () => processModule.resolveDeepSeekRuntime({
      deepseekRuntimeMode: 'embedded',
      deepseekGenerationRoot: path.join(root, 'missing'),
      deepseekBin: 'dsh',
    }),
    { code: 'deepseek_binary_unsupported' },
  );

  await assert.rejects(processModule.resolveDeepSeekRuntimeAsync({
    deepseekArtifactDir: root,
    deepseekBinOverride: path.join(root, 'entry.mjs'),
  }), { code: 'deepseek_binary_not_executable' });

  const probe = await processModule.probeDeepSeekRuntime({ deepseekBinOverride: process.execPath });

  assert.equal(probe.ok, false);
  assert.equal(probe.code, 'deepseek_binary_unsupported');
});

test('discovery закрепляет A; cache/settings различают B, профиль прав остаётся прежним', async (t) => {
  assert.ok(processModule, 'Descriptor пока отсутствует');

  const a = await fixture(t);
  const b = await fixture(t, 'B');
  const config = { deepseekBin: a.binary };
  const context = await deepseek.nativeSettings.context(config, a.root);

  config.deepseekBin = b.binary;

  let launched;
  const snapshot = await readDeepSeekSettings(config, context, { signal: new AbortController().signal },
    async (options) => {
      launched = options.runtime;

      return {
        stop: async () => {},
        client: { rpc: async () => ({
          namespaces: [],
          writable: true,
          hasDocument: true,
        }) },
      };
    });
  const prepared = await deepseek.nativeSettings.prepare(context, snapshot, [], {
    signal: new AbortController().signal,
  });
  const other = await deepseek.nativeSettings.context(config, a.root);

  assert.equal(launched.buildId, a.metadata.buildId);
  assert.equal(snapshot.source.version, a.metadata.source.version);
  assert.equal(prepared.runtimeIdentity, context.runtimeIdentity);
  assert.notEqual(other.binaryIdentity, context.binaryIdentity);
  assert.notEqual(
    await deepSeekCatalogCacheKey({ ...config, deepseekBin: a.binary }),
    await deepSeekCatalogCacheKey(config),
  );
  assert.equal(
    await deepseek.sessionBinding.securityProfile({ ...config, deepseekBin: a.binary }),
    await deepseek.sessionBinding.securityProfile(config),
  );
});
