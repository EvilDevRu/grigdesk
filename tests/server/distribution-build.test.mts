import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sha256File } from '../../shared/node/hash.ts';
import { createSandbox } from '../cli/helpers/sandbox.mts';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../..');

/**
 * Fixture закрепляет настоящий исполняемый Node/npm в локальном архиве по SHA.
 * Сетевой загрузчик, snapshot, CLI, runner и ворота не подменяются; рецепт задаёт
 * только маленькие child-команды вместо дорогих сборщиков и полного набора тестов.
 */
test('DIST-BUILD-FAIL-GATE: настоящий source dist выполняет тесты и блокирует bundle', async (t) => {
  const box = await createSandbox(t);
  const cache = path.join(box.home, 'node-cache');
  const runtimeName = `node-v${process.versions.node}-linux-x64`;
  const runtime = path.join(box.home, runtimeName);
  const trace = path.join(box.home, 'trace');
  const temporaryRecord = path.join(box.home, 'temporary-record.json');
  const cleanupRecord = path.join(box.home, 'cleanup-record.json');
  const marker = path.join(box.home, 'bundle-marker');
  const artifacts = path.join(box.home, 'artifacts-with-a-deliberately-long-socket-test-path');

  await fs.cp(path.join(repository, 'tools'), path.join(box.root, 'tools'), {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes('node_modules'),
  });

  // Major 1 заставляет штатный сторож проверить отпечаток в копии с временным ключом.
  await execute(process.execPath, ['tools/api-version.mjs', '--bump', 'major'], { cwd: box.root });

  const apiVersionPath = 'shared/client/apiVersion.ts';
  const originalApiVersion = await fs.readFile(path.join(box.root, apiVersionPath), 'utf8');

  for (const dir of ['server/src', 'server/build', 'web', 'desktop']) {
    await fs.mkdir(path.join(box.root, dir), { recursive: true });
  }

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

  const archive = path.join(cache, `${runtimeName}.tar.xz`);

  await execute('tar', ['-cJf', archive, '-C', box.home, runtimeName], {
    env: { ...process.env, XZ_OPT: '-0' },
  });
  await fs.writeFile(path.join(box.root, 'server/build/node-runtime.json'), JSON.stringify({
    version: process.versions.node,
    platform: 'linux-x64',
    sha256: await sha256File(archive),
  }));

  const stage = (id: string, group: string, source: string, needs: string[] = []) => ({
    id,
    group,
    needs,
    argv: ['node', '-e', source],
  });
  const note = (name: string) => `require('fs').appendFileSync(${JSON.stringify(trace)}, '${name}\\n');`;
  const recipe = { format: 1, stages: [
    stage('prepare-a', 'prepare-server', 'process.exit(0)'),
    stage('prepare-b', 'prepare-build', [
      "const fs = require('fs'), path = require('path');",
      "const generation = path.join(process.env.GRIGDESK_DEEPSEEK_NODE_CACHE,",
      "'generations', 'a'.repeat(64));",
      'fs.mkdirSync(generation, { recursive: true });',
      "fs.writeFileSync(path.join(generation, 'prepared-runtime'), 'pinned');",
    ].join('\n')),
    stage('prepare-web', 'prepare-web', 'process.exit(0)'),
    {
      id: 'api-fingerprint',
      group: 'server',
      argv: ['node', 'tools/api-version.mjs', '--check'],
    },
    stage('tests-a', 'server', [
      "const fs = require('fs'), path = require('path'), os = require('os');",
      "const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grigdesk-kimi-runtime-test-'));",
      "const broker = path.join(directory, 'private-state', 'broker', 'r', 'a'.repeat(20));",
      'fs.mkdirSync(broker, { recursive: true });',
      "const socket = path.join(broker, 'e.sock');",
      'if (Buffer.byteLength(socket) > 107) {',
      '  process.exit(78);',
      '}',
      "const server = require('net').createServer();",
      'server.listen(socket, () => {',
      `fs.writeFileSync(${JSON.stringify(temporaryRecord)}, JSON.stringify({`,
      'temporary: os.tmpdir(), mode: fs.statSync(os.tmpdir()).mode & 0o777,',
      'uid: fs.statSync(os.tmpdir()).uid }));',
      note('tests-a'),
      'server.close(() => process.exit(7));',
      '});',
    ].join('\n')),
    stage('tests-b', 'server', [
      note('tests-b'),
      "const source = require('url').pathToFileURL(",
      "require('path').resolve('shared/node/artifactsCleanup.ts'));",
      'import(source.href).then(async ({ cleanupArtifacts }) => {',
      "const report = await cleanupArtifacts({ root: process.env.GRIGDESK_TEST_DEEPSEEK_ROOT,",
      "scope: 'deepseek-tests', dryRun: true });",
      `require('fs').writeFileSync(${JSON.stringify(cleanupRecord)}, JSON.stringify(report));`,
      '});',
    ].join('\n')),
    stage('web', 'web', 'process.exit(0)'),
    stage('bundle', 'build', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`, ['server']),
  ] };

  await fs.writeFile(path.join(box.root, 'tools/releaseRecipe.json'), JSON.stringify(recipe));
  await execute('git', ['init', '-q'], { cwd: box.root });
  await execute('git', ['add', '.'], { cwd: box.root });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture'], { cwd: box.root });

  const result = await box.run(['dist', 'build'], {
    GRIGDESK_ARTIFACTS_DIR: artifacts,
    GRIGDESK_DIST_RUN_DIR: path.join(box.home, 'runs'),
    GRIGDESK_DIST_NODE_CACHE: cache,
  });

  assert.equal(result.code, 1, result.stderr);
  t.diagnostic(result.stdout + result.stderr);

  const [runDir] = (await fs.readdir(artifacts)).filter((name) => name.startsWith('dist-build-'));
  const receiptDir = path.join(artifacts, runDir!, 'receipts');
  const [receiptFile] = await fs.readdir(receiptDir);
  const receipt = JSON.parse(await fs.readFile(path.join(receiptDir, receiptFile!), 'utf8'));

  assert.equal(receipt.outcomes['api-fingerprint'].status, 'success');
  assert.equal(await fs.readFile(path.join(box.root, apiVersionPath), 'utf8'), originalApiVersion);
  assert.equal(await fs.readFile(path.join(artifacts, runDir!, 'source-clone', apiVersionPath), 'utf8'),
    originalApiVersion);
  assert.equal(await fs.readFile(trace, 'utf8'), 'tests-a\ntests-b\n');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });

  const [id] = await fs.readdir(path.join(box.home, 'runs'));
  const record = JSON.parse(await fs.readFile(path.join(box.home, 'runs', id!, 'run.json'), 'utf8'));

  assert.equal(record.stage, 'failed');
  assert.equal(record.artifacts.length, 0);

  const cleanup = JSON.parse(await fs.readFile(cleanupRecord, 'utf8'));

  assert.deepEqual(cleanup.entries, [], 'Уборщик тестов не должен обходить pinned runtime cache');

  const temporaryInfo = JSON.parse(await fs.readFile(temporaryRecord, 'utf8'));
  const temporary = temporaryInfo.temporary;

  assert.ok(path.isAbsolute(temporary));
  assert.ok(Buffer.byteLength(temporary) < 50);
  assert.equal(temporaryInfo.mode, 0o700);
  assert.equal(temporaryInfo.uid, process.getuid!());
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });

  // Подстановка ключа не должна скрывать несовпадение в исходном снимке.
  const contractsPath = path.join(box.root, 'shared/runtime/releaseChannelContracts.ts');

  await fs.appendFile(contractsPath, '\n// Изменение контракта после фиксации отпечатка.\n');

  const stale = await box.run(['dist', 'build'], {
    GRIGDESK_ARTIFACTS_DIR: artifacts,
    GRIGDESK_DIST_RUN_DIR: path.join(box.home, 'runs'),
    GRIGDESK_DIST_NODE_CACHE: cache,
  });

  assert.equal(stale.code, 2);
  assert.match(stale.stderr, /dist_source_api_fingerprint_mismatch/u);
  assert.deepEqual(await fs.readdir(path.join(box.home, 'runs')), [id]);
});
