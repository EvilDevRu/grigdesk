import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { nodeArchive } from '../../shared/node/seaBuild.ts';
import { completed } from '../cli/helpers/sandbox.mts';
import {
  DAY, ageTree, oldTree, present, retentionFixture, treeSnapshot,
} from '../helpers/deepseekRetentionFixture.mts';

const helperUrl = new URL('../helpers/deepseekBinary.mts', import.meta.url).href;
const worker = { version: '24.0.0', abi: '137' };

/**
 * Source-ветка получает готовность dependencies и identity без настоящих pinned-архивов.
 * Файловая уборка, выбор пути, metadata и verify выполняются исходным helper без подмен.
 */
function sourcePreflight(pinDigest: string): string {
  const doubles = {
    '/shared/node/hash.ts': [
      "import { createHash } from 'node:crypto';",
      "export const sha256 = (value) => createHash('sha256').update(value).digest('hex');",
      `export const sha256File = async () => ${JSON.stringify(pinDigest)};`,
    ].join('\n'),
    '/deepseek/scripts/prepareRuntimeDeps.mts': [
      'export async function readPreparedRuntimeDependencies(cacheDir) {',
      `  return { directory: cacheDir + '/deps', ...${JSON.stringify(worker)} };`,
      '}',
    ].join('\n'),
    '/deepseek/scripts/buildRuntime.mts': [
      'export async function deepSeekBuildInputs() {',
      '  return { source: {}, hashes: {} };',
      '}',
    ].join('\n'),
    '/deepseek/scripts/binaryInputs.mts': [
      'export async function binaryPackageInputs() {',
      '  return {};',
      '}',
    ].join('\n'),
  };

  return [
    "import { registerHooks } from 'node:module';",
    `const doubles = ${JSON.stringify(doubles)};`,
    'registerHooks({',
    '  load(url, context, nextLoad) {',
    '    const entry = Object.entries(doubles).find(([suffix]) => url.endsWith(suffix));',
    '    return entry ? { format: "module", source: entry[1], shortCircuit: true }',
    '      : nextLoad(url, context);',
    '  },',
    '});',
    `const { ensureTestDeepSeekBinary } = await import(${JSON.stringify(helperUrl)});`,
    'console.log(JSON.stringify(await ensureTestDeepSeekBinary()));',
  ].join('\n');
}

for (const mode of ['direct', 'symlink'] as const) {
  const title = `HP-NODE-CACHE: source helper сохраняет выбранный cache внутри retention family, ${mode}`;

  test(title, async (t) => {
    const box = await retentionFixture(t);
    const cache = await oldTree(box.root, 'explicit-cache/shared-node-cache');
    const pinFile = new URL('../../deepseek/build/node-runtime.json', import.meta.url);
    const pin = JSON.parse(await fs.readFile(pinFile, 'utf8'));

    await fs.writeFile(path.join(cache, nodeArchive(pin).name), 'pinned archive fixture');

    for (const relative of ['payloads/id', 'runtime-deps-node24', 'node-runtime']) {
      await oldTree(cache, relative);
    }

    await ageTree(cache, Date.now() - 8 * DAY);

    const identity = createHash('sha256').update(canonicalJson({
      package: {},
      generation: { source: {}, hashes: {} },
      worker,
    })).digest('hex');
    const directory = path.join(box.root, 'test-builds', identity);
    const binary = path.join(directory, 'bin/deepseek');

    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.cp(box.binary, binary);
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
      payload: { sha256: 'f'.repeat(64) },
    }));

    const unrelated = await oldTree(box.root, 'test-builds/unrelated');
    let selected = cache;

    if (mode === 'symlink') {
      selected = path.join(box.root, 'test-builds/cache-alias');
      await fs.symlink(cache, selected);
    }

    const before = await treeSnapshot(cache);
    const environment: NodeJS.ProcessEnv = { ...process.env, GRIGDESK_DEEPSEEK_NODE_CACHE: selected };

    delete environment.GRIGDESK_TEST_DEEPSEEK_BINARY;

    const child = spawn(process.execPath, ['--input-type=module', '-e', sourcePreflight(pin.sha256)], {
      cwd: '/',
      env: environment,
    });

    t.after(() => child.kill('SIGKILL'));

    const result = await completed(child);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).binary, binary);
    assert.equal(await present(cache), true);
    assert.deepEqual(await treeSnapshot(cache), before, 'Архив, payloads и dependencies остаются целыми');
    assert.equal(await present(unrelated), false, 'Retention действительно исполнялась в source-ветке');
  });
}
