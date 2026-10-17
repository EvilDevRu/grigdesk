import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

import { writeDeepSeekArtifactFixture } from '../helpers/deepSeekArtifactFixture.mts';
import { resolveDeepSeekRuntime } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { forkDeepSeekHome } from '../../tools/deepseekHomeFork.ts';
import { verifyDeepSeekSnapshot } from '../../tools/deepseekVendorManifest.ts';

const publication = await import('../../tools/deepseekRuntimePublication.ts').catch(() => null);
const exec = promisify(execFile);
// Корень репозитория не зависит от cwd: `npm test` запускает набор из server/.
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('generation отделена от staging и проверяется при activation/rollback', async (t) => {
  assert.ok(publication, 'publication API отсутствует');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-publish-'));
  const runtimeRoot = path.join(root, 'runtime');
  const a = await writeDeepSeekArtifactFixture(path.join(root, 'staging/A'), 'A');
  const b = await writeDeepSeekArtifactFixture(path.join(root, 'staging/B'), 'B');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await publication.publishDeepSeekGeneration(path.join(root, 'staging/A'), runtimeRoot);
  await fs.rm(path.join(root, 'staging/A'), { recursive: true });
  assert.equal(resolveDeepSeekRuntime({ deepseekRuntimeMode: 'embedded',
    deepseekGenerationRoot: runtimeRoot }).buildId, a.buildId);

  await publication.publishDeepSeekGeneration(path.join(root, 'staging/B'), runtimeRoot);
  await publication.activateDeepSeekGeneration(runtimeRoot, a.buildId);
  assert.equal(resolveDeepSeekRuntime({ deepseekRuntimeMode: 'embedded',
    deepseekGenerationRoot: runtimeRoot }).buildId, a.buildId);
  assert.ok(await fs.stat(path.join(runtimeRoot, 'builds', b.buildId)));

  await fs.appendFile(path.join(runtimeRoot, 'builds', b.buildId, 'entry.mjs'), '// corruption');
  await assert.rejects(publication.activateDeepSeekGeneration(runtimeRoot, b.buildId));
  assert.equal(resolveDeepSeekRuntime({ deepseekRuntimeMode: 'embedded',
    deepseekGenerationRoot: runtimeRoot }).buildId, a.buildId);
});

test('незавершённая публикация блокирует новый prompt и не скрывается PATH dsh', async (t) => {
  assert.ok(publication);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-pending-'));
  const artifact = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeDeepSeekArtifactFixture(artifact, 'A');
  await publication.publishDeepSeekGeneration(artifact, runtimeRoot);
  await fs.writeFile(path.join(runtimeRoot, 'publish-pending.json'), '{}');
  assert.throws(() => resolveDeepSeekRuntime({ deepseekRuntimeMode: 'embedded',
    deepseekGenerationRoot: runtimeRoot }), { code: 'deepseek_runtime_publish_pending' });
});

test('откат на несовместимый host/journal contract отказывает до смены current', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-incompatible-rollback-'));
  const runtimeRoot = path.join(root, 'runtime');
  const source = path.join(root, 'source');
  const a = await writeDeepSeekArtifactFixture(source, 'A');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await publication.publishDeepSeekGeneration(source, runtimeRoot);

  for (const field of ['hostContract', 'journalFormat']) {
    const metadata = structuredClone(a);

    metadata[field] = 2;
    metadata.inputIdentity.contract[field] = 2;
    metadata.buildId = createHash('sha256').update(JSON.stringify({
      inputIdentity: metadata.inputIdentity,
      payload: metadata.payload,
    })).digest('hex');
    metadata.runtimeVersion = `${metadata.source.version}.cockpit.b${metadata.buildId.slice(0, 16)}`;

    const directory = path.join(runtimeRoot, 'builds', metadata.buildId);

    await fs.cp(source, directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'runtime.json'), JSON.stringify(metadata));
    await assert.rejects(publication.activateDeepSeekGeneration(runtimeRoot, metadata.buildId), {
      code: 'deepseek_runtime_incompatible',
    });
    assert.equal(await fs.readlink(path.join(runtimeRoot, 'current')), `builds/${a.buildId}`);
  }
});

test('publish lock брошенного владельца снимается, живой владелец отказывает с pid', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-publish-lock-'));
  const runtimeRoot = path.join(root, 'runtime');
  const lock = path.join(runtimeRoot, '.publish-lock');
  const owner = path.join(lock, 'owner.json');
  const stale = new Date(Date.now() - 2 * 60_000);
  const a = await writeDeepSeekArtifactFixture(path.join(root, 'A'), 'A');
  const b = await writeDeepSeekArtifactFixture(path.join(root, 'B'), 'B');
  const publish = (name) => publication.publishDeepSeekGeneration(path.join(root, name), runtimeRoot);
  const current = () => fs.readlink(path.join(runtimeRoot, 'current'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await publish('A');

  // Сам тест — живой владелец; pid 1 без права сигнала даёт EPERM и тоже считается живым.
  for (const pid of [process.pid, 1]) {
    await fs.mkdir(lock);
    await fs.writeFile(owner, JSON.stringify({ pid }));
    await assert.rejects(publish('B'), new RegExp(`уже идёт \\(pid ${pid}\\)`));
    assert.deepEqual(JSON.parse(await fs.readFile(owner, 'utf8')), { pid });
    assert.equal(await current(), `builds/${a.buildId}`);
    await fs.rm(lock, { recursive: true });
  }

  // Свежий lock без owner.json: владелец мог ещё не успеть записать файл.
  await fs.mkdir(lock);
  await assert.rejects(publish('B'), /уже идёт/);
  assert.ok(await fs.stat(lock));
  assert.equal(await current(), `builds/${a.buildId}`);

  await fs.utimes(lock, stale, stale);
  await publish('B');
  assert.equal(await current(), `builds/${b.buildId}`);
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });

  await fs.mkdir(lock);
  await fs.writeFile(owner, '{"pid":');
  await fs.utimes(lock, stale, stale);
  await publish('A');
  assert.equal(await current(), `builds/${a.buildId}`);

  // Завершившийся владелец (ESRCH) брошен независимо от возраста lock.
  await fs.mkdir(lock);
  await fs.writeFile(owner, JSON.stringify({ pid: 2147483647 }));
  await publish('B');
  assert.equal(await current(), `builds/${b.buildId}`);
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});

test('повреждённое поколение с тем же buildId заменяется проверенной копией', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-publish-repair-'));
  const runtimeRoot = path.join(root, 'runtime');
  const a = await writeDeepSeekArtifactFixture(path.join(root, 'A'), 'A');
  const entry = path.join(runtimeRoot, 'builds', a.buildId, 'entry.mjs');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await publication.publishDeepSeekGeneration(path.join(root, 'A'), runtimeRoot);

  const original = await fs.readFile(entry, 'utf8');

  await fs.appendFile(entry, '// corruption');
  await publication.publishDeepSeekGeneration(path.join(root, 'A'), runtimeRoot);
  assert.equal(await fs.readFile(entry, 'utf8'), original);
  assert.equal(resolveDeepSeekRuntime({ deepseekRuntimeMode: 'embedded',
    deepseekGenerationRoot: runtimeRoot }).buildId, a.buildId);
  assert.deepEqual(await fs.readdir(path.join(runtimeRoot, 'builds')), [a.buildId]);
});

/**
 * Clean checkout содержит то же, что Git: manifest, патчи и лицензии без кэша исходников
 * `upstream/`, без node_modules и без собранного runtime.
 */
async function cleanCheckout(sourceRoot, root) {
  const upstream = path.join(sourceRoot, 'third_party/deepseek-harness/upstream');

  for (const relative of ['tools', 'shared', 'third_party/deepseek-harness']) {
    await fs.cp(path.join(sourceRoot, relative), path.join(root, relative), {
      recursive: true,
      filter: (source) => source !== upstream
        && !source.split(path.sep).some((part) => ['node_modules', '.git'].includes(part)),
    });
  }

  for (const relative of ['server/scripts/prepareDeepSeekRuntime.mts',
    'server/src/lib/deepseek/runtimeArtifact.ts', 'server/src/lib/deepseek/runtimeProcess.ts',
    'server/src/lib/deepseek/contract.ts', 'server/src/lib/nodeVersion.ts', 'server/package.json']) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, relative), path.join(root, relative));
  }
}

test('настоящая общая подготовка clean checkout работает в production без dsh и staging', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-clean-deepseek-'));
  const sourceRoot = REPO_ROOT;

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await cleanCheckout(sourceRoot, root);

  // Исходники Harness приходят из проверенной копии вместо сети, как у update worker;
  // брошенный после kill lock подготовки не блокирует сборку навсегда.
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    NODE_ENV: 'production',
    npm_config_cache: path.join(artifactsPath({ env: process.env, home: os.homedir() }),
      'deepseek-vendoring/npm-cache'),
    COCKPIT_DEEPSEEK_UPSTREAM_SEED: path.join(sourceRoot, 'third_party/deepseek-harness/upstream'),
  };
  const staleLock = path.join(root, 'server/runtime/deepseek/.prepare-lock');

  await fs.mkdir(staleLock, { recursive: true });
  await fs.writeFile(path.join(staleLock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));

  const args = [path.join(root, 'server/scripts/prepareDeepSeekRuntime.mts')];
  const { stdout } = await exec(process.execPath, args, {
    cwd: root,
    env,
    timeout: 240_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const info = JSON.parse(stdout.trim().split('\n').at(-1));

  assert.match(info.buildId, /^[a-f0-9]{64}$/);
  await assert.rejects(fs.stat(staleLock), { code: 'ENOENT' });
  await verifyDeepSeekSnapshot(path.join(root, 'third_party/deepseek-harness'));
  await exec(process.execPath, [...args, '--check'], {
    cwd: root,
    env,
    timeout: 30_000,
  });

  // Те же входы в другом checkout дают тот же buildId: предложенная установка берётся
  // как есть, без исходников, npm ci и сборки.
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-reuse-deepseek-'));

  t.after(() => fs.rm(other, { recursive: true, force: true }));
  await cleanCheckout(sourceRoot, other);

  const { stdout: reusedOutput } = await exec(process.execPath,
    [path.join(other, 'server/scripts/prepareDeepSeekRuntime.mts')], {
      cwd: other,
      env: { ...env, COCKPIT_DEEPSEEK_REUSE_RUNTIME: path.join(root, 'server/runtime/deepseek') },
      timeout: 60_000,
    });
  const reused = JSON.parse(reusedOutput.trim().split('\n').at(-1));

  assert.equal(reused.reused, true);
  assert.equal(reused.buildId, info.buildId);
  await assert.rejects(fs.stat(path.join(other, 'server/runtime/deepseek/builds')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(other, 'third_party/deepseek-harness/upstream')), {
    code: 'ENOENT',
  });

  // Recovery работает в собственном clean checkout и исполняет npm только через fixture shim.
  // Нормальная сборка выше использовала настоящий npm и реальные native prerequisites.
  await fs.writeFile(path.join(root, '.gitignore'),
    'node_modules/\nserver/runtime/\nweb/dist/\nthird_party/deepseek-harness/upstream/\n');
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'owned recovery fixture'], { cwd: root });

  const sha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const runtimeRoot = path.join(root, 'server/runtime/deepseek');
  const pending = path.join(runtimeRoot, 'publish-pending.json');
  const jobId = '00000000-0000-4000-8000-000000000001';
  const marker = {
    jobId,
    workerPid: process.pid,
    targetSha: sha,
    previousSha: sha,
  };

  await fs.writeFile(pending, JSON.stringify(marker));
  await assert.rejects(exec(process.execPath, [...args, '--recover-job', jobId], { cwd: root, env }));
  assert.ok(await fs.stat(pending));
  marker.workerPid = 2147483647;
  await fs.writeFile(pending, JSON.stringify(marker));

  const shim = path.join(root, 'server/.state/recovery-shim');

  await fs.mkdir(shim, { recursive: true });
  await fs.mkdir(path.join(root, 'web'), { recursive: true });
  await fs.writeFile(path.join(root, '.git/info/exclude'), 'server/.state/\nweb/\n');
  await fs.writeFile(path.join(shim, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await exec(process.execPath, [...args, '--recover-job', jobId], {
    cwd: root,
    env: { ...env, PATH: `${shim}:${env.PATH}` },
    timeout: 30_000,
  });
  await assert.rejects(fs.stat(pending), { code: 'ENOENT' });

  await fs.rm(path.join(root, 'tools/deepseek-build/node_modules'), { recursive: true });

  const moved = path.join(root, 'moved generation');

  await fs.rename(info.generationDir, moved);
  await fs.rm(path.join(root, 'server/runtime/deepseek'), { recursive: true });

  const { stdout: version } = await exec(process.execPath, [path.join(moved, 'entry.mjs'), '-V'], {
    env, timeout: 30_000,
  });

  assert.equal(version.trim(), '0.1.5-rc.2');
});

test('fork home отвергает вложенную папку и symlink parent без изменения источника', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-fork-boundaries-'));
  const source = path.join(root, 'home');
  const generation = path.join(root, 'generation');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'journal'), 'original');
  await writeDeepSeekArtifactFixture(generation, 'A');
  await fs.symlink(source, path.join(root, 'alias'));
  await assert.rejects(forkDeepSeekHome(source, path.join(source, '..child/new'), generation));
  await assert.rejects(forkDeepSeekHome(source, path.join(root, 'alias/new/home'), generation));
  assert.deepEqual(await fs.readdir(source), ['journal']);
});
