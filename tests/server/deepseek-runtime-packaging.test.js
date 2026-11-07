// Исторический publisher остаётся только для legacy fixtures перехода.
// Readiness проверяет текущий binary consumer и никогда не вызывает этот publisher.
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
import { forkDeepSeekHome } from '../helpers/deepseekLegacyHomeFork.mts';
import { readDeepSeekArtifact } from '../helpers/deepseekLegacyArtifact.mts';
import { writeDeepSeekMetadataStub } from '../helpers/deepseekBinaryStub.mts';
import { ensureTestDeepSeekBinary } from '../helpers/deepseekBinary.mts';
import { sha256File } from '../../shared/node/hash.ts';
import { SOURCE_RUNTIME_FILES } from './helpers/sourceRuntimeFiles.mts';

const publication = await import('../helpers/deepseekLegacyPublication.mts').catch(() => null);
const exec = promisify(execFile);
// Корень репозитория не зависит от cwd: `npm test` запускает набор из server/.
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('legacy publication отделяет generation от staging и проверяет activation/rollback', async (t) => {
  assert.ok(publication, 'publication API отсутствует');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-publish-'));
  const runtimeRoot = path.join(root, 'runtime');
  const a = await writeDeepSeekArtifactFixture(path.join(root, 'staging/A'), 'A');
  const b = await writeDeepSeekArtifactFixture(path.join(root, 'staging/B'), 'B');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await publication.publishDeepSeekGeneration(path.join(root, 'staging/A'), runtimeRoot);
  await fs.rm(path.join(root, 'staging/A'), { recursive: true });
  assert.equal(readDeepSeekArtifact(path.join(runtimeRoot, 'current')).artifact.buildId, a.buildId);

  await publication.publishDeepSeekGeneration(path.join(root, 'staging/B'), runtimeRoot);
  await publication.activateDeepSeekGeneration(runtimeRoot, a.buildId);
  assert.equal(readDeepSeekArtifact(path.join(runtimeRoot, 'current')).artifact.buildId, a.buildId);
  assert.ok(await fs.stat(path.join(runtimeRoot, 'builds', b.buildId)));

  await fs.appendFile(path.join(runtimeRoot, 'builds', b.buildId, 'entry.mjs'), '// corruption');
  await assert.rejects(publication.activateDeepSeekGeneration(runtimeRoot, b.buildId));
  assert.equal(readDeepSeekArtifact(path.join(runtimeRoot, 'current')).artifact.buildId, a.buildId);
});

test('legacy pending не блокирует выбранный binary и остаётся нетронутым', async (t) => {
  const { binary } = await writeDeepSeekMetadataStub(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-pending-'));
  const runtimeRoot = path.join(root, 'runtime');
  const pending = path.join(runtimeRoot, 'publish-pending.json');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(runtimeRoot);
  await fs.writeFile(pending, '{}');
  assert.equal(resolveDeepSeekRuntime({
    deepseekBin: binary, deepseekGenerationRoot: runtimeRoot,
  }).kind, 'binary');
  assert.equal(await fs.readFile(pending, 'utf8'), '{}');
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
    metadata.runtimeVersion = `${metadata.source.version}.grigdesk.b${metadata.buildId.slice(0, 16)}`;

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
  assert.equal(readDeepSeekArtifact(path.join(runtimeRoot, 'current')).artifact.buildId, a.buildId);
  assert.deepEqual(await fs.readdir(path.join(runtimeRoot, 'builds')), [a.buildId]);
});

/**
 * Readiness потребителя использует только server/shared и выбранный ELF.
 * Копия намеренно не содержит source package, vendor, tools или runtime generation.
 */
async function cleanCheckout(sourceRoot, root) {
  for (const relative of ['shared', 'server/src/lib/deepseek']) {
    await fs.cp(path.join(sourceRoot, relative), path.join(root, relative), { recursive: true });
  }

  for (const relative of ['server/package.json', 'server/deepseek-host-contract.json',
    'server/scripts/prepareDeepSeekRuntime.mts', ...SOURCE_RUNTIME_FILES]) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, relative), path.join(root, relative));
  }
}

test('read-only readiness clean checkout использует ELF без source package и не трогает legacy state',
  async (t) => {
    const candidate = await ensureTestDeepSeekBinary();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-clean-deepseek-'));

    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await cleanCheckout(REPO_ROOT, root);
    await fs.mkdir(path.join(root, 'bin'));
    await fs.copyFile(candidate.binary, path.join(root, 'bin/deepseek'));
    await fs.chmod(path.join(root, 'bin/deepseek'), 0o555);

    const runtimeRoot = path.join(root, 'server/runtime/deepseek');
    const pending = path.join(runtimeRoot, 'publish-pending.json');

    await fs.mkdir(runtimeRoot, { recursive: true });
    await fs.writeFile(pending, '{}');

    const original = await sha256File(path.join(root, 'bin/deepseek'));
    const args = [path.join(root, 'server/scripts/prepareDeepSeekRuntime.mts')];
    const env = {
      PATH: '',
      HOME: root,
      GRIGDESK_HOME: root,
      NODE_ENV: 'production',
    };
    const { stdout } = await exec(process.execPath, args, {
      cwd: root,
      env,
      timeout: 30000,
    });
    const info = JSON.parse(stdout);

    assert.equal(info.packageId, candidate.info.packageId);
    assert.equal(info.runtimeVersion, candidate.info.runtimeVersion);
    assert.equal(await sha256File(path.join(root, 'bin/deepseek')), original);
    assert.equal(await fs.readFile(pending, 'utf8'), '{}');
    await assert.rejects(fs.access(path.join(root, 'deepseek')));
    await assert.rejects(fs.access(path.join(runtimeRoot, 'builds')));
    await assert.rejects(exec(process.execPath, [...args, '--recover-job', 'legacy-job'], {
      cwd: root, env,
    }));
    assert.equal(await fs.readFile(pending, 'utf8'), '{}');
    await fs.rm(path.join(root, 'bin/deepseek'));
    await assert.rejects(exec(process.execPath, args, { cwd: root, env }), (error) => {
      assert.match(error.stderr, /install:binary/u);

      return true;
    });
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
