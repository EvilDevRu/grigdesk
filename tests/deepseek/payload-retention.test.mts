import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { completed } from '../cli/helpers/sandbox.mts';
import { DAY, ageTree, oldTree, present, retentionFixture } from '../helpers/deepseekRetentionFixture.mts';

const directoryLockUrl = new URL('../../shared/node/directoryLock.ts', import.meta.url).href;
const cleanupUrl = new URL('../../shared/node/artifactsCleanup.ts', import.meta.url).href;
const payloadUrl = new URL('../../deepseek/scripts/buildPayload.mts', import.meta.url).href;
const worker = { version: '24.21.0', abi: '137' };

interface LeaseProbe {
  owner: {
    pid: number;
    starttime: string;
    token: string;
  };
  reason: string;
}

interface PayloadProbeConfiguration {
  phase: 'package' | 'journal';
  root: string;
  cache: string;
  generation: string;
  markers: string;
  probeUrl: string;
  workerNode: string;
  nodeSha256: string;
  artifact: unknown;
}

/**
 * Псевдо-worker исполняет настоящие child_process вызовы builder без Node SEA и компиляции.
 * Journal-фаза запускает общую проверку lease в отдельном процессе до ожидаемой ошибки.
 */
function workerProgram(): string {
  return [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    '/**',
    ' * Identity соответствует только этой изолированной фикстуре.',
    ' * Journal завершается ошибкой после проверки активного lock родительского builder.',
    ' */',
    'async function main() {',
    "  if (process.argv[2] === '--print') {",
    `    console.log(JSON.stringify(${JSON.stringify(worker)}));`,
    '    return;',
    '  }',
    "  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../probe.json'), 'utf8'));",
    '  const { leaseProbe } = await import(config.probeUrl);',
    "  await leaseProbe('journal', config);",
    "  throw new Error('fixture-journal-failure');",
    '}',
    'main().catch((error) => {',
    '  console.error(error.message);',
    '  process.exitCode = 9;',
    '});',
  ].join('\n');
}

/**
 * Проверяются настоящий owner, отказ второго владельца и защита поколения вне K от уборки.
 * Маркер фиксирует token фазы, чтобы сравнить упаковку и journal без тайминговых ожиданий.
 */
function leaseProbeProgram(): string {
  return [
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    `import { acquireDirectoryLock } from ${JSON.stringify(directoryLockUrl)};`,
    `import { cleanupArtifacts } from ${JSON.stringify(cleanupUrl)};`,
    '/**',
    ' * Старое выбранное поколение защищает реальный lock, а не возраст или лимит K.',
    ' * Одновременная уборка удаляет незанятое поколение и сохраняет текущего владельца.',
    ' */',
    'export async function leaseProbe(phase, config) {',
    "  const lockPath = config.generation + '.lock';",
    "  const owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));",
    "  assert.equal(typeof owner.token, 'string');",
    '  await assert.rejects(acquireDirectoryLock(lockPath, { waitMs: 0 }), {',
    "    code: 'directory_lock_busy',",
    '  });',
    '  const report = await cleanupArtifacts({',
    '    root: config.root,',
    "    scope: 'deepseek-tests',",
    '    keepGenerations: 1,',
    '  });',
    '  const relative = path.relative(config.root, config.generation);',
    '  const entry = report.entries.find((value) => value.path === relative);',
    '  assert.equal(report.errorCount, 0);',
    "  assert.equal(entry.reason, 'locked');",
    '  assert.ok(await fs.lstat(config.generation));',
    "  const current = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));",
    '  assert.deepEqual(current, owner);',
    "  assert.equal(await fs.lstat(path.join(config.cache, 'generations/free')).catch(() => null), null);",
    "  await fs.writeFile(path.join(config.markers, phase + '.json'), JSON.stringify({",
    '    owner,',
    '    reason: entry.reason,',
    '  }));',
    '}',
  ].join('\n');
}

/**
 * Заменяются только готовность dependencies, build identity, artifact verifier и упаковка.
 * Сам prepareBinaryPayload и directory lock остаются исходными, включая оба пути finally.
 */
function builderProgram(config: PayloadProbeConfiguration): string {
  const doubles = {
    '/deepseek/scripts/prepareRuntimeDeps.mts': [
      'export async function readPreparedRuntimeDependencies() {',
      `  return ${JSON.stringify({
        ...worker,
        node: config.workerNode,
        nodeSha256: config.nodeSha256,
        directory: path.join(config.cache, 'runtime-deps-node24'),
      })};`,
      '}',
    ].join('\n'),
    '/deepseek/scripts/buildRuntime.mts': [
      'export async function deepSeekBuildInputs() {',
      '  return { source: {}, hashes: {} };',
      '}',
    ].join('\n'),
    '/deepseek/src/runtime/artifact.ts': [
      'export async function readWorkerArtifact() {',
      `  return { artifact: ${JSON.stringify(config.artifact)} };`,
      '}',
    ].join('\n'),
    '/deepseek/scripts/packagePayload.mts': [
      `import { leaseProbe } from ${JSON.stringify(config.probeUrl)};`,
      'export async function packagePayload() {',
      `  const config = ${JSON.stringify(config)};`,
      "  await leaseProbe('package', config);",
      "  if (config.phase === 'package') {",
      "    throw new Error('fixture-package-failure');",
      '  }',
      '  return {};',
      '}',
    ].join('\n'),
  };

  return [
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs/promises';",
    "import { registerHooks } from 'node:module';",
    `import { acquireDirectoryLock } from ${JSON.stringify(directoryLockUrl)};`,
    `const config = ${JSON.stringify(config)};`,
    `const doubles = ${JSON.stringify(doubles)};`,
    'registerHooks({',
    '  load(url, context, nextLoad) {',
    '    const entry = Object.entries(doubles).find(([suffix]) => url.endsWith(suffix));',
    '    return entry ? { format: "module", source: entry[1], shortCircuit: true }',
    '      : nextLoad(url, context);',
    '  },',
    '});',
    `const { prepareBinaryPayload } = await import(${JSON.stringify(payloadUrl)});`,
    'await assert.rejects(prepareBinaryPayload(process.argv[1], {',
    '  nodeCacheDir: config.cache,',
    '  outDir: process.argv[1],',
    '  binaryVersion: null,',
    '  payload: null,',
    '}), new RegExp("fixture-" + config.phase + "-failure"));',
    "const lockPath = config.generation + '.lock';",
    'assert.equal(await fs.lstat(lockPath).catch(() => null), null);',
    'const next = await acquireDirectoryLock(lockPath, { waitMs: 0 });',
    'await next.release();',
    'console.log(JSON.stringify({ phase: config.phase, lockReleased: true }));',
  ].join('\n');
}

for (const phase of ['package', 'journal'] as const) {
  test(`PL-RETENTION: lease держится до ${phase} и снимается при ошибке`, async (t) => {
    const box = await retentionFixture(t);
    const cache = path.join(box.root, 'node-cache');
    const work = path.join(box.home, 'work');
    const workerNode = path.join(cache, 'node-runtime/bin/node');
    const program = workerProgram();
    const nodeSha256 = createHash('sha256').update(program).digest('hex');
    const identity = createHash('sha256').update(canonicalJson({
      hashes: {},
      source: {},
      worker: { ...worker, sha256: nodeSha256 },
    })).digest('hex');
    const generation = await oldTree(cache, `generations/${identity}`);
    const probeFile = path.join(box.home, 'lease-probe.mjs');
    const markers = path.join(box.home, 'markers');

    await fs.mkdir(path.dirname(workerNode), { recursive: true });
    await fs.mkdir(path.join(work, 'bin'), { recursive: true });
    await fs.mkdir(markers);
    await fs.writeFile(workerNode, program, { mode: 0o755 });
    await fs.cp(workerNode, path.join(work, 'bin/node'));
    await fs.writeFile(probeFile, leaseProbeProgram());
    await fs.writeFile(path.join(generation, 'runtime.json'), JSON.stringify(box.info.glm.inputs));
    await ageTree(generation, Date.now() - 12 * DAY);
    await oldTree(cache, 'generations/latest', 17, Date.now() - 8 * DAY);
    await oldTree(cache, 'generations/free', 17, Date.now() - 20 * DAY);

    const config: PayloadProbeConfiguration = {
      phase,
      root: box.root,
      cache,
      generation,
      markers,
      probeUrl: pathToFileURL(probeFile).href,
      workerNode,
      nodeSha256,
      artifact: {
        source: { version: box.info.upstreamVersion },
        buildId: box.info.buildId,
        runtimeVersion: box.info.runtimeVersion,
        hostContract: box.info.hostContract,
        capabilities: box.info.capabilities,
      },
    };

    await fs.writeFile(path.join(work, 'probe.json'), JSON.stringify(config));

    const child = spawn(process.execPath, ['--input-type=module', '-e', builderProgram(config), work], {
      cwd: '/',
      env: process.env,
    });

    t.after(() => child.kill('SIGKILL'));

    const result = await completed(child);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).lockReleased, true);
    assert.equal(await present(`${generation}.lock`), false);
    assert.equal(await present(generation), true);
    assert.equal(await present(path.join(cache, 'generations/free')), false);

    const packaged = JSON.parse(await fs.readFile(path.join(markers, 'package.json'), 'utf8')) as LeaseProbe;

    assert.equal(packaged.owner.pid, child.pid);
    assert.equal(packaged.reason, 'locked');

    if (phase === 'journal') {
      const journal = JSON.parse(await fs.readFile(path.join(markers, 'journal.json'), 'utf8')) as LeaseProbe;

      assert.deepEqual(journal.owner, packaged.owner, 'Один token охватывает package и journal');
      assert.equal(journal.reason, 'locked');
    }
  });
}
