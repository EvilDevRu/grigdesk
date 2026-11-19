import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { sha256File } from '../../shared/node/hash.ts';
import { createSandbox } from '../cli/helpers/sandbox.mts';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../..');

test('DIST-MAC-BUILD-FAIL-GATE: отказ mac-check закрывает упаковку и UUID', async (t) => {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');

  const box = await createSandbox(t);
  const artifacts = path.join(box.home, 'artifacts');
  const runs = path.join(box.home, 'runs');
  const cache = path.join(box.home, 'cache');
  const runtimeName = `node-v${process.versions.node}-darwin-arm64`;
  const runtime = path.join(box.home, runtimeName);
  const archive = path.join(cache, runtimeName + '.tar.xz');
  const prepare = path.join(box.home, 'prepare');
  const packageMarker = path.join(box.home, 'package');
  const candidateMarker = path.join(box.home, 'candidate');

  await fs.cp(path.join(repository, 'tools'), path.join(box.root, 'tools'), {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes('node_modules'),
  });

  for (const name of ['server/build', 'server/src/lib', 'web', 'desktop']) {
    await fs.mkdir(path.join(box.root, name), { recursive: true });
  }

  await fs.copyFile(path.join(repository, 'server/src/lib/factoryDarwinRuntime.ts'),
    path.join(box.root, 'server/src/lib/factoryDarwinRuntime.ts'));
  await fs.writeFile(path.join(box.root, 'server/src/app.ts'), 'export {};\n');
  await fs.writeFile(path.join(box.root, 'web/package.json'), '{}\n');
  await fs.writeFile(path.join(box.root, 'desktop/package.json'), '{}\n');
  await fs.mkdir(path.join(runtime, 'bin'), { recursive: true });
  await fs.mkdir(path.join(runtime, 'lib/node_modules'), { recursive: true });
  await fs.copyFile(process.execPath, path.join(runtime, 'bin/node'));
  await fs.cp(path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm'),
    path.join(runtime, 'lib/node_modules/npm'), { recursive: true });
  await fs.symlink('../lib/node_modules/npm/bin/npm-cli.js', path.join(runtime, 'bin/npm'));
  await fs.mkdir(cache);
  await execute('/usr/bin/tar', ['-cJf', archive, '-C', box.home, runtimeName]);

  const manifest = {
    version: process.versions.node,
    platform: 'darwin-arm64',
    sha256: await sha256File(archive),
  };

  await fs.writeFile(path.join(box.root, 'server/build/node-runtime-darwin-arm64.json'),
    JSON.stringify(manifest));

  /**
   * Отмечает фактическое начало стадии в приватной папке.
   * Отказ проверки не может проскочить дальше как успешно пропущенная группа.
   */
  function stage(id: string, group: string, needs: string[], marker: string, code: number) {
    return {
      id,
      group,
      needs,
      argv: ['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.version);
        process.exit(${code});`],
    };
  }

  const recipe = {
    format: 1,
    stages: [
      stage('prepare', 'mac-prepare', [], prepare, 0),
      stage('mac-check', 'mac-check', ['mac-prepare'], prepare + '.check', 17),
      stage('package', 'mac-build', ['mac-check'], packageMarker, 0),
      stage('candidate', 'candidate', [], candidateMarker, 0),
    ],
  };

  await fs.writeFile(path.join(box.root, 'tools/releaseRecipe.json'), JSON.stringify(recipe));
  await execute(process.execPath, ['tools/api-version.mjs', '--bump', 'major'], { cwd: box.root });
  await execute('git', ['init', '-q'], { cwd: box.root });
  await execute('git', ['add', '.'], { cwd: box.root });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture'], { cwd: box.root });

  const result = await box.run(['dist', 'build'], {
    GRIGDESK_ARTIFACTS_DIR: artifacts,
    GRIGDESK_DIST_RUN_DIR: runs,
    GRIGDESK_DIST_NODE_CACHE: cache,
  });

  assert.equal(result.code, 1, result.stderr);
  assert.equal(await fs.readFile(prepare, 'utf8'), process.version);
  assert.equal(await fs.readFile(prepare + '.check', 'utf8'), process.version);
  await assert.rejects(fs.lstat(packageMarker), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(candidateMarker), { code: 'ENOENT' });

  const [runDir] = await fs.readdir(artifacts);
  const receipts = path.join(artifacts, runDir!, 'receipts');
  const [file] = await fs.readdir(receipts);
  const receipt = JSON.parse(await fs.readFile(path.join(receipts, file!), 'utf8'));

  assert.equal(receipt.environment.os, 'darwin');
  assert.equal(receipt.environment.arch, 'arm64');
  assert.equal(receipt.outcomes['mac-check'].exitCode, 17);
  assert.equal(receipt.outcomes.package.status, 'blocked');
  assert.equal(receipt.cleanupConfirmed, true);

  const [id] = await fs.readdir(runs);
  const record = JSON.parse(await fs.readFile(path.join(runs, id!, 'run.json'), 'utf8'));

  assert.equal(record.stage, 'failed');
  assert.deepEqual(record.artifacts, []);
});
