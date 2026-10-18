import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { readDeepSeekSettings } from '../../server/src/lib/executorSettings/deepseek.ts';
import { deepSeekCatalogCacheKey } from '../../server/src/lib/deepseek/catalog.ts';

const artifactModule = await import('../../server/src/lib/deepseek/runtimeArtifact.ts').catch(() => null);
const processModule = await import('../../server/src/lib/deepseek/runtimeProcess.ts').catch(() => null);

/**
 * Малый артефакт использует настоящий формат identity и файловые хеши сборки.
 * Разные payload дают разные поколения при одинаковой upstream version.
 */
async function fixture(t, marker = 'A', changes = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek runtime '));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

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

  return { root, metadata };
}

test('descriptor читает candidate при произвольном cwd и пробелах, не выбирает PATH dsh', async (t) => {
  assert.ok(artifactModule && processModule, 'Единый проверяющий descriptor пока отсутствует');

  const { root, metadata } = await fixture(t);
  const descriptor = processModule.resolveDeepSeekRuntime({ deepseekArtifactDir: root });

  assert.equal(descriptor.command, process.execPath);
  assert.deepEqual(descriptor.prefixArgs, [path.join(root, 'entry.mjs')]);
  assert.equal(descriptor.upstreamVersion, metadata.source.version);
  assert.equal(descriptor.buildId, metadata.buildId);
  assert.ok(Object.isFrozen(descriptor));
});

test('повреждение зависимости при прежнем entry инвалидирует integrity cache', async (t) => {
  assert.ok(artifactModule && processModule, 'Проверка payload пока отсутствует');

  const { root } = await fixture(t);
  const runtime = processModule.resolveDeepSeekRuntime({ deepseekArtifactDir: root });

  await fs.writeFile(path.join(root, 'dependency.js'), 'corrupt');
  assert.throws(
    () => processModule.resolveDeepSeekRuntime({ deepseekArtifactDir: root }),
    { code: 'deepseek_runtime_corrupt' },
  );
  assert.throws(() => processModule.verifyDeepSeekRuntimeDescriptor(runtime), {
    code: 'deepseek_runtime_corrupt',
  });
});

test('host contract отвергается даже с целыми хешами; capabilities защищены identity', async (t) => {
  assert.ok(artifactModule && processModule, 'Контракт runtime пока не проверяется');

  const incompatible = await fixture(t, 'A', { hostContract: 999 });

  assert.throws(
    () => processModule.resolveDeepSeekRuntime({ deepseekArtifactDir: incompatible.root }),
    { code: 'deepseek_runtime_incompatible' },
  );

  const { root, metadata } = await fixture(t);

  metadata.capabilities.settingsAcp = true;
  await fs.writeFile(path.join(root, 'runtime.json'), JSON.stringify(metadata));
  assert.throws(
    () => processModule.resolveDeepSeekRuntime({ deepseekArtifactDir: root }),
    { code: 'deepseek_runtime_corrupt' },
  );
});

test('смена current сохраняет descriptor A и запрещает подготовленный A запуск на B', async (t) => {
  assert.ok(artifactModule && processModule, 'Закрепление generation пока отсутствует');

  const first = await fixture(t);
  const second = await fixture(t, 'B');
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-current-'));

  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(runtimeRoot, 'builds'));
  await fs.rename(first.root, path.join(runtimeRoot, 'builds', 'A'));
  await fs.rename(second.root, path.join(runtimeRoot, 'builds', 'B'));
  await fs.symlink('builds/A', path.join(runtimeRoot, 'current'));

  const config = { deepseekRuntimeMode: 'embedded', deepseekGenerationRoot: runtimeRoot };
  const a = processModule.resolveDeepSeekRuntime(config);

  await fs.unlink(path.join(runtimeRoot, 'current'));
  await fs.symlink('builds/B', path.join(runtimeRoot, 'current'));

  const b = processModule.resolveDeepSeekRuntime(config);

  assert.notEqual(a.identity, b.identity);
  assert.equal(a.prefixArgs[0], path.join(runtimeRoot, 'builds', 'A', 'entry.mjs'));
  assert.throws(
    () => processModule.assertDeepSeekPreparedRuntime(b, { runtimeIdentity: a.identity }),
    { code: 'deepseek_runtime_changed' },
  );
});

test('missing embedded не выбирает dsh; внешний override имеет отдельную identity', async (t) => {
  assert.ok(artifactModule && processModule, 'Выбор runtime пока отсутствует');

  const { root } = await fixture(t);

  assert.throws(
    () => processModule.resolveDeepSeekRuntime({
      deepseekRuntimeMode: 'embedded',
      deepseekGenerationRoot: path.join(root, 'missing'),
      deepseekBin: 'dsh',
    }),
    { code: 'deepseek_runtime_missing' },
  );

  const external = processModule.resolveDeepSeekRuntime({
    deepseekArtifactDir: root,
    deepseekBinOverride: path.join(root, 'entry.mjs'),
  });

  assert.equal(external.kind, 'external');
  assert.equal(external.command, path.join(root, 'entry.mjs'));
  assert.deepEqual(external.prefixArgs, []);

  const probe = await processModule.probeDeepSeekRuntime({ deepseekBinOverride: process.execPath });

  assert.equal(probe.ok, false);
});

test('discovery закрепляет A: version, cache, settings и security binding различают B', async (t) => {
  assert.ok(processModule, 'Descriptor пока отсутствует');

  const a = await fixture(t);
  const b = await fixture(t, 'B');
  const config = { deepseekBin: process.execPath, deepseekArtifactDir: a.root };
  const context = await deepseek.nativeSettings.context(config, a.root);

  config.deepseekArtifactDir = b.root;

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
    deepSeekCatalogCacheKey({ ...config, deepseekArtifactDir: a.root }), deepSeekCatalogCacheKey(config),
  );
  assert.notEqual(
    deepseek.sessionBinding.securityProfile({ ...config, deepseekArtifactDir: a.root }),
    deepseek.sessionBinding.securityProfile(config),
  );
});
