import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { deepSeekPackagePaths } from '../../deepseek/scripts/paths.ts';
import {
  materializeDeepSeekSnapshot,
  prepareDeepSeekSync,
  verifyDeepSeekSnapshot,
} from '../../deepseek/scripts/deepseekVendorManifest.ts';
import { createDeepSeekVendorFixture } from '../helpers/deepseekVendor.mts';

const exec = promisify(execFile);

test('verifier читает vendor нового пакета одинаково из корня и deepseek/', async () => {
  const paths = deepSeekPackagePaths();
  const expected = fileURLToPath(new URL('../../deepseek/vendor/deepseek-harness', import.meta.url));

  assert.equal(paths.vendorDir, expected);

  const manifest = await verifyDeepSeekSnapshot(paths.vendorDir);
  const pathsUrl = new URL('../../deepseek/scripts/paths.ts', import.meta.url).href;
  const verifierUrl = new URL('../../deepseek/scripts/deepseekVendorManifest.ts', import.meta.url).href;
  const source = `
import { deepSeekPackagePaths } from ${JSON.stringify(pathsUrl)};
import { verifyDeepSeekSnapshot } from ${JSON.stringify(verifierUrl)};
const paths = deepSeekPackagePaths();
const manifest = await verifyDeepSeekSnapshot(paths.vendorDir);
console.log(JSON.stringify({ vendorDir: paths.vendorDir, commit: manifest.commit }));
`;

  for (const cwd of [fileURLToPath(new URL('../..', import.meta.url)), paths.root]) {
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', source], { cwd });

    assert.deepEqual(JSON.parse(stdout), {
      vendorDir: expected,
      commit: manifest.commit,
    });
  }
});

test('offline snapshot отвергает порчу и неизвестный файл, восстанавливая кэш', async (t) => {
  const input = await createDeepSeekVendorFixture(t);
  const candidate = await prepareDeepSeekSync({ ...input, commit: input.sha });
  const directory = candidate.stagingDir;
  const seed = path.join(input.root, 'seed');
  const entry = path.join(directory, 'upstream/packages/a/src/index.ts');
  const original = await fs.readFile(entry);

  await verifyDeepSeekSnapshot(directory);
  await fs.cp(path.join(directory, 'upstream'), seed, { recursive: true });
  await fs.appendFile(entry, 'tampered');
  await assert.rejects(verifyDeepSeekSnapshot(directory), /Hash или режим/u);
  await fs.writeFile(entry, original);
  await fs.writeFile(path.join(directory, 'upstream/unknown.txt'), 'unknown');
  await assert.rejects(verifyDeepSeekSnapshot(directory), /Состав снимка/u);
  await materializeDeepSeekSnapshot(directory, {
    seedDir: seed,
    fetchSource: async () => {
      throw new Error('Offline fixture не должна обращаться к сети');
    },
  });

  assert.equal((await verifyDeepSeekSnapshot(directory)).commit, input.sha);
  assert.deepEqual(await fs.readFile(entry), original);
  assert.deepEqual(await fs.readFile(path.join(input.sourceDir, 'packages/a/src/index.ts')), original);
  await assert.rejects(fs.stat(path.join(directory, 'upstream/unknown.txt')), { code: 'ENOENT' });
});

test('отсутствующий commit и конфликт патча сохраняют исходный snapshot и source', async (t) => {
  const input = await createDeepSeekVendorFixture(t);
  const candidate = await prepareDeepSeekSync({ ...input, commit: input.sha });

  await fs.rename(candidate.stagingDir, input.vendorDir);

  const before = await fs.readFile(path.join(input.vendorDir, 'upstream.lock.json'));
  const source = await fs.readFile(path.join(input.sourceDir, 'packages/a/src/index.ts'));

  await assert.rejects(prepareDeepSeekSync({ ...input, commit: '1'.repeat(40) }));

  const patchesDir = path.join(input.root, 'patches');

  await fs.mkdir(patchesDir);
  await fs.writeFile(path.join(patchesDir, 'conflict.patch'), `\
diff --git a/packages/a/src/index.ts b/packages/a/src/index.ts
--- a/packages/a/src/index.ts
+++ b/packages/a/src/index.ts
@@ -1 +1 @@
-export const absent = 9;
+export const value = 2;
`);
  await assert.rejects(prepareDeepSeekSync({
    ...input,
    commit: input.sha,
    patchesDir,
  }), /patch|патч/iu);
  assert.deepEqual(await fs.readFile(path.join(input.vendorDir, 'upstream.lock.json')), before);
  assert.deepEqual(await fs.readFile(path.join(input.sourceDir, 'packages/a/src/index.ts')), source);
  await verifyDeepSeekSnapshot(input.vendorDir);
});
