import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { prepareDeepSeekSync, publishDeepSeekSync, verifyDeepSeekSnapshot }
  from '../../deepseek/scripts/deepseekVendorManifest.ts';

const exec = promisify(execFile);
// Корень репозитория не зависит от cwd: `npm test` запускает набор из server/.
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('настоящий новый SHA проходит build/transport gates; конфликт сохраняет snapshot/current',
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-upstream-update-'));
    const sourceDir = path.join(root, 'source');
    const vendorDir = path.join(root, 'vendor');
    const installedVendor = path.join(REPO_ROOT, 'deepseek/vendor/deepseek-harness');
    const git = async (...args) => (await exec('git', ['-C', sourceDir, ...args])).stdout.trim();

    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.cp(installedVendor, vendorDir, { recursive: true });
    await fs.cp(path.join(installedVendor, 'upstream'), sourceDir, { recursive: true });
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Fixture');
    await git('config', 'user.email', 'fixture@example.invalid');
    await fs.appendFile(path.join(sourceDir, 'packages/llm/llm-deepseek/src/index.ts'),
      '\n// Isolated upstream update fixture resource revision.\n');
    await git('add', '.');
    await git('commit', '-m', 'isolated future upstream fixture');

    const commit = await git('rev-parse', 'HEAD');
    const before = await verifyDeepSeekSnapshot(vendorDir);
    const runtimeRoot = path.join(root, 'runtime');

    await fs.mkdir(runtimeRoot);
    await fs.symlink('builds/previous', path.join(runtimeRoot, 'current'));

    const candidate = await prepareDeepSeekSync({
      sourceDir,
      vendorDir,
      commit,
      selection: before.selection,
      stagingParent: path.join(root, 'staging'),
    });

    assert.notEqual(commit, before.commit);
    await publishDeepSeekSync(candidate);
    assert.equal((await verifyDeepSeekSnapshot(vendorDir)).commit, commit);
    assert.equal(await fs.readlink(path.join(runtimeRoot, 'current')), 'builds/previous');

    const manifestBytes = await fs.readFile(path.join(vendorDir, 'upstream.lock.json'));

    await fs.writeFile(path.join(sourceDir, 'packages/bundle/web-app/src/index.ts'),
      'export const incompatibleFixture = true;\n');
    await git('add', '.');
    await git('commit', '-m', 'isolated incompatible API/patch fixture');

    await assert.rejects(prepareDeepSeekSync({
      sourceDir,
      vendorDir,
      commit: await git('rev-parse', 'HEAD'),
      selection: before.selection,
      stagingParent: path.join(root, 'conflict-staging'),
    }));
    assert.deepEqual(await fs.readFile(path.join(vendorDir, 'upstream.lock.json')), manifestBytes);
    assert.equal(await fs.readlink(path.join(runtimeRoot, 'current')), 'builds/previous');
  });
