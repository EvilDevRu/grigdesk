import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256 } from '../../shared/node/hash.ts';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import {
  COMPOSITION_REVISION,
  discoverRuntimeClosure,
  readRuntimeComposition,
  runtimeYaml,
} from '../../tools/runtimeComposition.ts';
import {
  assertKnownDynamicReferences,
  llmPiAiExternalDependencies,
  scanDynamicRuntimeReferences,
} from '../../tools/deepseekBuildInputs.ts';
import { writeDeepSeekLicenseInventory } from '../../tools/deepseekBuildLicenses.ts';
import { deepSeekBuildInputs } from '../../tools/buildDeepSeekRuntime.mts';

const PLUGIN = '@deepseek-ai/dsh-llm-pi-ai';
const ARTIFACTS = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'glm/G1');
const UPSTREAM = path.resolve(import.meta.dirname, '../../third_party/deepseek-harness/upstream');

/**
 * Малый стенд проверяет обход manifests и фильтрацию YAML настоящими функциями сборки.
 * Его синтетические зависимости не требуют установки или ручной правки upstream.
 */
async function compositionFixture(t) {
  await fs.mkdir(ARTIFACTS, { recursive: true });

  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'composition-'));
  const packages = [
    ['bundle/base', 'base'],
    ['bundle/web-app', 'web-app'],
    ['bundle/acp-app', 'acp-app'],
    ['host/app-boot', 'app-boot'],
    ['host/cmdline', 'cmdline'],
    ['host/launch-environment', 'launch-environment'],
    ['host/http-proxy', 'http-proxy'],
    ['typert/generator', 'typert-generator'],
    ['hooks/claude-code', 'hooks-claude-code'],
    ['mcp/client', 'mcp-client'],
    ['llm/llm-pi-ai', 'llm-pi-ai'],
  ];

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const [relative, name] of packages) {
    const directory = path.join(root, 'packages', relative);
    const manifest = {
      name: `@deepseek-ai/dsh-${name}`,
      version: '0.0.0-synthetic',
      dependencies: name === 'llm-pi-ai' ? { 'synthetic-model-library': '^3.0.0' } : {},
    };

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
  }

  for (const bundle of ['base', 'web-app', 'acp-app']) {
    const rows = bundle === 'base' ? [{ insert: [{ id: 'llm-pi-ai', name: PLUGIN }] }] : [];

    await fs.writeFile(path.join(root, 'packages/bundle', bundle, 'cordis.patch.yml'),
      runtimeYaml().dump(rows));
  }

  await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), runtimeYaml().dump({
    importers: {
      'packages/llm/llm-pi-ai': {
        dependencies: {
          'synthetic-model-library': { version: '3.4.0' },
        },
      },
    },
  }));

  return root;
}

test('llm-pi-ai входит в замыкание как host overlay, а base YAML не содержит его строки', async (t) => {
  const root = await compositionFixture(t);
  const closure = await discoverRuntimeClosure(root);
  const layers = await readRuntimeComposition(root);

  assert.equal(closure.packages.some((item) => item.name === PLUGIN), true);
  assert.deepEqual(closure.reasons[PLUGIN], ['GrigDesk server-owned overlay']);
  assert.deepEqual(closure.external[PLUGIN], { 'synthetic-model-library': '3.4.0' });
  assert.equal(layers.base.some((patch) => patch.insert?.some((row) => row.name === PLUGIN)), false);
  assert.equal(COMPOSITION_REVISION, 'grigdesk-host-web-acp-v3');
});

test('pi-ai разрешён в exact 0.85.1 с integrity из upstream lock', async () => {
  const lock = runtimeYaml().load(await fs.readFile(path.join(UPSTREAM, 'pnpm-lock.yaml'), 'utf8'));
  const dependencies = llmPiAiExternalDependencies(lock);
  const modelLibrary = dependencies.find((entry) => entry.name === '@earendil-works/pi-ai');

  assert.deepEqual(modelLibrary, {
    name: '@earendil-works/pi-ai',
    version: '0.85.1',
    integrity: lock.packages['@earendil-works/pi-ai@0.85.1'].resolution.integrity,
  });
});

test('внешние зависимости llm-pi-ai выводятся из upstream lock', async () => {
  const lock = runtimeYaml().load(await fs.readFile(path.join(UPSTREAM, 'pnpm-lock.yaml'), 'utf8'));
  const dependencies = llmPiAiExternalDependencies(lock);

  assert.equal(dependencies.length, 190);
  assert.equal(new Set(dependencies.map((entry) => `${entry.name}@${entry.version}`)).size, 190);
  assert.equal(dependencies.some((entry) => entry.name === 'openai' && entry.version === '6.40.0'), true);
  assert.equal(dependencies.some((entry) => entry.name === '@aws-sdk/client-bedrock-runtime'), true);
  assert.equal(dependencies.every((entry) => /^sha512-/u.test(entry.integrity)), true);

  const brokenIntegrity = structuredClone(lock);

  delete brokenIntegrity.packages['openai@6.40.0'].resolution.integrity;
  assert.throws(() => llmPiAiExternalDependencies(brokenIntegrity), /integrity.*openai/u);

  const brokenSnapshot = structuredClone(lock);

  delete brokenSnapshot.snapshots[
    '@earendil-works/pi-ai@0.85.1(@modelcontextprotocol/sdk@1.29.0(zod@4.4.3))(ws@8.21.0)(zod@4.4.3)'
  ];
  assert.throws(() => llmPiAiExternalDependencies(brokenSnapshot), /snapshot/u);

  const native = structuredClone(lock);

  native.packages['openai@6.40.0'].requiresBuild = true;
  assert.throws(() => llmPiAiExternalDependencies(native), /нативн/u);
});

test('каждый внешний пакет closure pi-ai имеет лицензию в notices', async (t) => {
  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'licenses-'));
  const lock = runtimeYaml().load(await fs.readFile(path.join(UPSTREAM, 'pnpm-lock.yaml'), 'utf8'));
  const dependencies = llmPiAiExternalDependencies(lock);
  const modules = path.resolve(import.meta.dirname, '../../tools/deepseek-build/node_modules');
  const compilerPackages = ['typescript', 'esbuild', '@esbuild'];

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Compiler не поставляется, а notices type dependencies сохраняются до удаления их файлов.
  await fs.cp(modules, path.join(root, 'node_modules'), {
    recursive: true,
    filter: (source) => !compilerPackages.some((name) => source === path.join(modules, name)),
  });
  await fs.copyFile(path.join(UPSTREAM, '../THIRD_PARTY_NOTICES.md'),
    path.join(root, 'THIRD_PARTY_NOTICES.md'));

  await assert.doesNotReject(writeDeepSeekLicenseInventory(root, []));

  const inventory = JSON.parse(await fs.readFile(path.join(root, 'licenses/index.json'), 'utf8'));

  for (const dependency of dependencies) {
    const record = inventory.packages.find((entry) => entry.name === dependency.name
      && entry.version === dependency.version);

    assert.ok(record, `${dependency.name}@${dependency.version}`);
    assert.ok(record.files.length > 0);

    for (const file of record.files) {
      assert.match(file.sha256, /^[a-f\d]{64}$/u);
      assert.ok((await fs.stat(path.join(root, 'licenses', file.copy))).size > 0);
    }
  }
});

test('license supplements входят в identity сборки и не разрешают соседнюю версию', async (t) => {
  const directory = path.resolve(import.meta.dirname, '../../tools/deepseek-build/licenses');
  const sources = JSON.parse(await fs.readFile(path.join(directory, 'sources.json'), 'utf8'));
  const inputs = await deepSeekBuildInputs(path.dirname(UPSTREAM));

  for (const source of sources.files) {
    const bytes = await fs.readFile(path.join(directory, source.file));

    assert.equal(inputs.hashes[`tools/deepseek-build/licenses/${source.file}`], sha256(bytes));
  }

  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'unknown-license-'));
  const dependency = path.join(root, 'node_modules/@earendil-works/pi-ai');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(dependency, { recursive: true });
  await fs.writeFile(path.join(dependency, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-ai',
    version: '0.85.2',
    license: 'MIT',
  }));
  await assert.rejects(writeDeepSeekLicenseInventory(root, []), /license\/notice.*0\.85\.2/u);
});

test('вычисляемый import вне dynamic-imports.json даёт отказ сборки', async (t) => {
  const root = await fs.mkdtemp(path.join(ARTIFACTS, 'dynamic-import-'));
  const directory = 'node_modules/synthetic-model-library/dist';

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, directory), { recursive: true });
  await fs.writeFile(path.join(root, directory, 'loader.js'),
    'export const load = (moduleId) => import(moduleId);\n'
    + 'export const builtin = () => import("node:fs");\n');

  const references = await scanDynamicRuntimeReferences(root, [], [directory]);
  const known = JSON.parse(await fs.readFile(
    path.resolve(import.meta.dirname, '../../tools/deepseek-build/dynamic-imports.json'), 'utf8',
  ));

  assert.deepEqual(references, [{ file: `${directory}/loader.js`, expression: 'import(moduleId)' }]);
  assert.throws(() => assertKnownDynamicReferences(references, known), /неизвестный dynamic/u);
  assertKnownDynamicReferences(references, [{ ...references[0], reason: 'Синтетический локальный модуль' }]);
});
