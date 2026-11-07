import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Настоящий локальный Git хранит provenance фикстуры независимо от рабочего дерева.
 * Импорт и публикация используют временные каталоги, без сети и production runtime.
 */
export async function createDeepSeekVendorFixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-vendor-'));
  const sourceDir = path.join(root, 'source');
  const vendorDir = path.join(root, 'vendor');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(sourceDir);
  await exec('git', ['init', '-q', sourceDir]);
  await exec('git', ['-C', sourceDir, 'config', 'user.email', 'fixture@example.invalid']);
  await exec('git', ['-C', sourceDir, 'config', 'user.name', 'Fixture']);

  const files = {
    'package.json': '{"version":"0.1.5-rc.2"}\n',
    LICENSE: 'MIT License\nCopyright (c) fixture\n',
    'THIRD_PARTY_NOTICES.md': '# Notices\nFixture dependencies\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'packages/a/package.json': '{"name":"a","dependencies":{"b":"workspace:*"}}\n',
    'packages/a/src/index.ts': 'export const value = 1;\n',
    'packages/a/resource.yaml': 'enabled: true\n',
    'packages/b/package.json': '{"name":"b"}\n',
    'packages/b/src/index.ts': 'export const peer = true;\n',
  };

  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(sourceDir, name)), { recursive: true });
    await fs.writeFile(path.join(sourceDir, name), content);
  }

  const commit = async () => {
    await exec('git', ['-C', sourceDir, 'add', '.']);
    await exec('git', ['-C', sourceDir, 'commit', '-qm', 'fixture']);

    return (await exec('git', ['-C', sourceDir, 'rev-parse', 'HEAD'])).stdout.trim();
  };
  const sha = await commit();
  const selection = {
    versionFile: 'package.json',
    dependencyLockPath: 'pnpm-lock.yaml',
    roots: [
      { path: 'packages/a', reason: 'Транспорт фикстуры' },
      { path: 'packages/b', reason: 'Обязательная зависимость' },
    ],
  };

  return {
    root,
    sourceDir,
    vendorDir,
    sha,
    selection,
    commit,
  };
}
