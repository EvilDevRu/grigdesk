import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { writeDeepSeekArtifactFixture } from '../helpers/deepSeekArtifactFixture.mts';
import { publishDeepSeekGeneration } from '../../tools/deepseekRuntimePublication.ts';
import { resolveDeepSeekRuntime } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { CockpitUpdateManager } from '../../server/src/lib/cockpitUpdate.ts';

import { CockpitReleaseService, readPersistentState, writePersistentState }
  from '../../server/src/lib/cockpitRelease.ts';

const exec = promisify(execFile);
// Корень репозитория не зависит от cwd: `npm test` запускает набор из server/.
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const legacyFile = path.join(ROOT, 'tests/fixtures/cockpit-update/legacy-worker.js');

/**
 * Три disposable релиза проверяют installed updater, а не код worker в target archive.
 * Npm пакеты пустые; generation fixture отдельно от настоящей clean build проверки.
 */
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-updater-transition-'));
  const publisher = path.join(temp, 'publisher');
  const origin = path.join(temp, 'origin.git');
  const root = path.join(temp, 'work');
  const git = async (cwd, ...args) => (await exec('git', args, { cwd })).stdout.trim();
  const write = async (relative, value) => {
    const file = path.join(publisher, relative);

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  };

  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await git(temp, 'init', '-b', 'main', publisher);
  await git(publisher, 'config', 'user.name', 'Fixture');
  await git(publisher, 'config', 'user.email', 'fixture@example.invalid');
  await write('.gitignore', 'node_modules/\nweb/dist/\nserver/.state/\nserver/runtime/\n'
    + 'web/dist.cockpit-backup-*/\nserver/node_modules.cockpit-backup-*/\n');

  for (const name of ['server', 'web']) {
    await write(`${name}/package.json`, JSON.stringify({
      name: `fixture-${name}`,
      type: 'module',
      scripts: name === 'web' ? { build: 'node build.js' } : {},
    }));
    await write(`${name}/package-lock.json`, JSON.stringify({
      name: `fixture-${name}`,
      lockfileVersion: 3,
      packages: { '': { name: `fixture-${name}` } },
    }));
  }

  await write('web/build.js', 'import fs from "node:fs/promises";\n'
    + 'await fs.mkdir("dist", {recursive:true});\n'
    + 'await fs.copyFile("../VERSION", "dist/index.html");\n');
  await write('bin/restart', '#!/bin/sh\nexit 0\n');
  await write('bin/cockpit', '#!/bin/sh\nmkdir -p server/.state\nprintf "%s\\n" "$1" '
    + '>>server/.state/prepared\n');
  await write('server/src/lib/cockpitRelease.ts', await fs.readFile(
    path.join(ROOT, 'server/src/lib/cockpitRelease.ts')));
  await write('server/src/workers/cockpit-update-worker.js', await fs.readFile(legacyFile));
  await write('tests/server/cockpit-release.test.js', 'import test from "node:test";\n'
    + 'test("legacy smoke", () => {});\n');

  // Annotated fixture tags моделируют строгую stable-публикацию Cockpit.
  // Все commits ограничены временным publisher, рабочее дерево проекта не меняется.
  const commit = async (version) => {
    await write('VERSION', version + '\n');
    await git(publisher, 'add', '.');
    await git(publisher, 'commit', '-m', version);
    await git(publisher, 'tag', '-a', `v${version}`, '-m', version);

    return git(publisher, 'rev-parse', 'HEAD');
  };
  const legacySha = await commit('0.1.0');

  for (const relative of ['server/src/workers/cockpit-update-worker.js',
    'server/src/lib/nodeVersion.ts', 'server/src/lib/deepseek/runtimeArtifact.ts',
    'server/src/lib/deepseek/runtimeProcess.ts', 'server/src/lib/deepseek/contract.ts',
    'tools/deepseekRuntimePublication.ts', 'tests/helpers/deepSeekArtifactFixture.mts']) {
    await write(relative, await fs.readFile(path.join(ROOT, relative)));
  }

  await write('server/deepseek-runtime-contract.json', JSON.stringify({
    format: 1,
    publishContract: 1,
    mode: 'installed',
  }));
  await write('server/scripts/prepareDeepSeekRuntime.mts', [
    'import fs from "node:fs/promises";',
    'import { writeDeepSeekArtifactFixture } from "../../tests/helpers/deepSeekArtifactFixture.mts";',
    'const root = "runtime/deepseek";',
    'const artifact = await writeDeepSeekArtifactFixture(root + "/candidate", "embedded");',
    'await fs.mkdir(root + "/builds", {recursive:true});',
    'await fs.rename(root + "/candidate", root + "/builds/" + artifact.buildId);',
    'await fs.symlink("builds/" + artifact.buildId, root + "/current");',
  ].join('\n'));
  await write('tests/server/cockpit-release.test.js', [
    'import test from "node:test";',
    'import { assertReleasePublishContract } from "../../server/src/lib/cockpitRelease.ts";',
    'test("target publish gate", () => assertReleasePublishContract(process.cwd(),',
    '  process.env.COCKPIT_RELEASE_PUBLISH_CONTRACT));',
  ].join('\n'));

  const intermediateSha = await commit('0.2.0');

  await write('server/deepseek-runtime-contract.json', JSON.stringify({
    format: 1,
    publishContract: 1,
    mode: 'embedded',
  }));
  // Publisher целевого релиза намеренно непригоден: installed worker обязан публиковать
  // и откатывать своим кодом, загруженным до fast-forward, а не модулем из нового checkout.
  await write('tools/deepseekRuntimePublication.ts',
    'throw new Error("Publisher целевого релиза загружен после смены checkout");\n');

  const embeddedSha = await commit('0.3.0');

  await git(temp, 'init', '--bare', origin);
  await git(publisher, 'remote', 'add', 'origin', origin);
  await git(publisher, 'push', 'origin', 'main', '--tags');
  await git(temp, 'clone', '--branch', 'main', origin, root);
  await git(root, 'reset', '--hard', legacySha);
  await fs.mkdir(path.join(root, 'web/dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'web/dist/index.html'), 'legacy');
  await fs.mkdir(path.join(root, 'server/node_modules'), { recursive: true });

  // Каждый вызов запускает worker именно из установленного дерева.
  // Унаследованный marker удаляется: новый worker обязан выставить его самостоятельно.
  const update = async (sha, tag, {
    reject = false,
    failPhase = '',
    interrupt = false,
    pendingDuringBuild = '',
  } = {}) => {
    const state = path.join(root, 'server/.state/update.json');
    const id = randomUUID();
    const before = await git(root, 'rev-parse', 'HEAD');
    const npmLog = path.join(temp, `npm-${id}.log`);

    await fs.mkdir(`${state}.job-lock`, { recursive: true });
    await fs.writeFile(`${state}.job-lock/owner.json`, JSON.stringify({ id }));
    await writePersistentState(state, { job: {
      id,
      kind: 'update',
      status: 'queued',
      targetSha: sha,
      targetTag: tag,
      targetVersion: tag.slice(1),
      expectedCheckoutSha: before,
    } });

    if (failPhase === 'web' || failPhase === 'server') {
      const destination = failPhase === 'web' ? 'web/dist' : 'server/node_modules';
      const backup = path.join(root, `${destination}.cockpit-backup-${id}`);

      await fs.mkdir(backup, { recursive: true });
      await fs.writeFile(path.join(backup, 'obstruction'), 'owned fixture');
    } else if (failPhase === 'runtime') {
      // Lock живого владельца (сам тест) не считается брошенным и обязан остановить публикацию.
      const lock = path.join(root, 'server/runtime/deepseek/.publish-lock');

      await fs.mkdir(lock, { recursive: true });
      await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    }

    const env = { ...process.env };

    delete env.COCKPIT_RELEASE_PUBLISH_CONTRACT;
    delete env.NODE_TEST_CONTEXT;

    // Обёртка npm пишет журнал вызовов и при необходимости подкладывает чужой pending
    // во время сборки web: так видно, дошёл ли worker до установки и что он удалил при сбое.
    const npmWrappers = await fs.mkdtemp(path.join(temp, 'npm-wrappers-'));
    const realNpm = (await exec('which', ['npm'])).stdout.trim();

    await fs.writeFile(path.join(npmWrappers, 'npm'), '#!/bin/bash\n'
      + 'printf "%s\\n" "$*" >>"$FIXTURE_NPM_LOG"\n'
      + 'if [ "$1 $2" = "run build" ] && [ -n "$FIXTURE_PENDING_BODY" ]; then\n'
      + '  mkdir -p "$(dirname "$FIXTURE_PENDING")"\n'
      + '  printf "%s" "$FIXTURE_PENDING_BODY" >"$FIXTURE_PENDING"\n'
      + 'fi\n'
      + 'exec "$FIXTURE_REAL_NPM" "$@"\n', { mode: 0o755 });
    env.PATH = `${npmWrappers}:${env.PATH}`;
    env.FIXTURE_NPM_LOG = npmLog;
    env.FIXTURE_REAL_NPM = realNpm;
    env.FIXTURE_PENDING = path.join(root, 'server/runtime/deepseek/publish-pending.json');
    env.FIXTURE_PENDING_BODY = pendingDuringBuild;

    const barrier = path.join(temp, 'merge-barrier');

    if (interrupt) {
      const wrappers = path.join(temp, 'wrappers');
      const realGit = (await exec('which', ['git'])).stdout.trim();

      await fs.mkdir(wrappers);
      await fs.writeFile(path.join(wrappers, 'git'), '#!/bin/bash\n'
        + 'case " $* " in *" merge --ff-only "*)\n'
        + '  touch "$FIXTURE_BARRIER"\n'
        + '  while :; do sleep 0.05; done;;\nesac\n'
        + 'exec "$FIXTURE_REAL_GIT" "$@"\n', { mode: 0o755 });
      env.PATH = `${wrappers}:${env.PATH}`;
      env.FIXTURE_BARRIER = barrier;
      env.FIXTURE_REAL_GIT = realGit;
    }

    const workerArgs = [path.join(root, 'server/src/workers/cockpit-update-worker.js'),
      '--root', root, '--state', state, '--job', id, '--mode', 'script'];
    const run = exec(interrupt ? 'setsid' : process.execPath,
      interrupt ? ['--wait', process.execPath, ...workerArgs] : workerArgs, {
      cwd: root,
      env,
      timeout: 120_000,
    });

    if (interrupt) {
      // Только созданная этим fixture process group получает сигнал.
      // Barrier стоит после pending marker и до fast-forward checkout.
      const outcome = run.catch(() => null);

      try {
        const deadline = Date.now() + 30_000;

        while (true) {
          try {
            await fs.stat(barrier);

            break;
          } catch {
            assert.ok(Date.now() < deadline, 'Worker не дошёл до publication barrier');
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      } finally {
        process.kill(-run.child.pid, 'SIGKILL');
        await outcome;
      }

      return { state, job: (await readPersistentState(state)).job };
    }

    if (reject) {
      await assert.rejects(run);
    } else {
      try {
        await run;
      } catch (error) {
        const job = (await readPersistentState(state)).job;

        throw new Error(`${tag}: ${JSON.stringify(job?.error)}: ${error.message}`);
      }
    }

    const npmCalls = (await fs.readFile(npmLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);

    return {
      state,
      job: (await readPersistentState(state)).job,
      npmCalls,
    };
  };

  /**
   * Следующий релиз публикуется в тот же origin поверх последнего commit fixture.
   * Тест сам решает, какие файлы релиза отличаются от предыдущего.
   */
  const release = async (version, files) => {
    for (const [relative, value] of Object.entries(files)) {
      await write(relative, value);
    }

    const sha = await commit(version);

    await git(publisher, 'push', 'origin', 'main', '--tags');

    return sha;
  };

  return {
    root,
    git,
    legacySha,
    intermediateSha,
    embeddedSha,
    update,
    release,
  };
}

test('неизменённый legacy updater требует промежуточный релиз даже при обоих latest tags', async (t) => {
  const bytes = await fs.readFile(legacyFile);

  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '7559f158ba3c39cb9c32c26aa29e23944a00a911001c5fb9254be8599f9b3b71');

  const f = await fixture(t);
  const oldService = new CockpitReleaseService({ rootDir: f.root });
  const latest = await oldService.checkRemote();

  assert.equal(latest.latest.tag, 'v0.3.0');
  oldService.stop();

  const failed = await f.update(f.embeddedSha, 'v0.3.0', { reject: true });

  assert.equal(failed.job.error.code, 'smoke_test_failed');
  assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), f.legacySha);
  assert.equal(await fs.readFile(path.join(f.root, 'web/dist/index.html'), 'utf8'), 'legacy');
  await assert.rejects(fs.stat(path.join(f.root, 'server/runtime/deepseek/current')), { code: 'ENOENT' });

  const intermediate = await f.update(f.intermediateSha, 'v0.2.0');

  assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), f.intermediateSha);

  const intermediateService = new CockpitReleaseService({ rootDir: f.root, statePath: intermediate.state });

  assert.equal((await intermediateService.getStatus({ fresh: true })).job.status, 'done');
  intermediateService.stop();

  const finished = await f.update(f.embeddedSha, 'v0.3.0');

  assert.equal(finished.job.status, 'restarting');
  assert.match(finished.job.expectedRuntimeBuildId, /^[a-f0-9]{64}$/);

  const newService = new CockpitReleaseService({ rootDir: f.root, statePath: finished.state });

  assert.equal((await newService.getStatus({ fresh: true })).job.status, 'done');
  newService.stop();
});

test('неизменённая сборка DeepSeek переиспользуется без сборки, публикации и маркера', async (t) => {
  const f = await fixture(t);

  await f.update(f.intermediateSha, 'v0.2.0');
  await f.update(f.embeddedSha, 'v0.3.0');

  const runtimeRoot = path.join(f.root, 'server/runtime/deepseek');
  const current = await fs.readlink(path.join(runtimeRoot, 'current'));
  const builds = await fs.readdir(path.join(runtimeRoot, 'builds'));
  // Target prepare видит предложенный runtime установки и кэш исходников; publisher 0.3.0
  // непригоден намеренно — повторное использование не должно его загружать.
  const reuseSha = await f.release('0.4.0', {
    'server/scripts/prepareDeepSeekRuntime.mts': [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const offered = process.env.COCKPIT_DEEPSEEK_REUSE_RUNTIME || "";',
      'const seed = process.env.COCKPIT_DEEPSEEK_UPSTREAM_SEED || "";',
      'if (!path.isAbsolute(offered) || !seed.endsWith("third_party/deepseek-harness/upstream")) {',
      '  process.exit(3);',
      '}',
      'const buildId = path.basename(fs.realpathSync(path.join(offered, "current")));',
      'console.log(JSON.stringify({ reused: true, buildId,',
      '  generationDir: path.join(offered, "builds", buildId) }));',
    ].join('\n'),
  });
  const reused = await f.update(reuseSha, 'v0.4.0');

  assert.equal(reused.job.status, 'restarting');
  assert.equal(reused.job.expectedRuntimeBuildId, path.basename(current));
  assert.equal(await fs.readlink(path.join(runtimeRoot, 'current')), current);
  assert.deepEqual(await fs.readdir(path.join(runtimeRoot, 'builds')), builds);
  await assert.rejects(fs.stat(path.join(runtimeRoot, 'publish-pending.json')), { code: 'ENOENT' });

  const service = new CockpitReleaseService({ rootDir: f.root, statePath: reused.state });

  assert.equal((await service.getStatus({ fresh: true })).job.status, 'done');
  service.stop();
});

test('точная процедура промежуточного релиза сохраняет dirty checkout и проверяет tag/SHA', async (t) => {
  const f = await fixture(t);
  const script = path.join(ROOT, 'bin/upgrade-publish-contract');
  const run = (sha = f.intermediateSha) => exec('bash', [script,
    '--tag', 'v0.2.0', '--sha', sha], {
    cwd: f.root,
    env: { ...process.env, COCKPIT_UPGRADE_ROOT: f.root },
    timeout: 30_000,
  });
  const dirty = path.join(f.root, 'owned-untracked.txt');

  await fs.writeFile(dirty, 'сохранить');
  await assert.rejects(run());
  assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), f.legacySha);
  assert.equal(await fs.readFile(dirty, 'utf8'), 'сохранить');
  await fs.rm(dirty);
  await assert.rejects(run(f.embeddedSha));
  assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), f.legacySha);
  await run();
  assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), f.intermediateSha);
  assert.equal(await fs.readFile(path.join(f.root, 'server/.state/prepared'), 'utf8'), 'deps\nbuild\n');

  await f.git(f.root, 'config', 'user.name', 'Fixture');
  await f.git(f.root, 'config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(f.root, 'owned-local.txt'), 'diverged');
  await f.git(f.root, 'add', 'owned-local.txt');
  await f.git(f.root, 'commit', '-m', 'owned local divergence');

  const local = await f.git(f.root, 'rev-parse', 'HEAD');

  await assert.rejects(run());
  assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), local);
});

for (const phase of ['web', 'server', 'runtime']) {
  test(`сбой публикации ${phase} возвращает прежний checkout, каталоги и current`, async (t) => {
    const f = await fixture(t);

    await f.update(f.intermediateSha, 'v0.2.0');

    const previous = path.join(f.root, 'server/.state/previous-generation');
    const a = await writeDeepSeekArtifactFixture(previous, 'previous');
    const runtimeRoot = path.join(f.root, 'server/runtime/deepseek');

    await publishDeepSeekGeneration(previous, runtimeRoot);

    const result = await f.update(f.embeddedSha, 'v0.3.0', { reject: true, failPhase: phase });

    assert.equal(result.job.error.code, 'publish_failed');
    assert.equal(result.job.recovery, 'previous-checkout-restored');
    assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), f.intermediateSha);
    assert.equal(await fs.readFile(path.join(f.root, 'web/dist/index.html'), 'utf8'), '0.2.0\n');
    assert.equal(await fs.readlink(path.join(runtimeRoot, 'current')), `builds/${a.buildId}`);
    await assert.rejects(fs.stat(path.join(runtimeRoot, 'publish-pending.json')), { code: 'ENOENT' });

    if (phase === 'runtime') {
      assert.match(result.job.error.message, new RegExp(`уже идёт \\(pid ${process.pid}\\)`));
    }
  });
}

/**
 * Прежнее поколение делается непригодным на настоящем формате manifest: повреждённый payload
 * или согласованный identity с будущим host contract. current указывает на него напрямую.
 */
async function unusableCurrent(root, runtimeRoot, kind) {
  const staging = path.join(root, 'server/.state', `unusable-${kind}`);
  const metadata = await writeDeepSeekArtifactFixture(staging, `unusable-${kind}`);

  if (kind === 'incompatible') {
    metadata.hostContract = 2;
    metadata.inputIdentity.contract.hostContract = 2;
    metadata.buildId = createHash('sha256').update(JSON.stringify({
      inputIdentity: metadata.inputIdentity,
      payload: metadata.payload,
    })).digest('hex');
    metadata.runtimeVersion = `${metadata.source.version}.cockpit.b${metadata.buildId.slice(0, 16)}`;
    await fs.writeFile(path.join(staging, 'runtime.json'), JSON.stringify(metadata));
  }

  const generation = path.join(runtimeRoot, 'builds', metadata.buildId);
  const link = `builds/${metadata.buildId}`;

  await fs.cp(staging, generation, { recursive: true });

  if (kind === 'corrupt') {
    await fs.appendFile(path.join(generation, 'entry.mjs'), '// corruption');
  }

  await fs.rm(path.join(runtimeRoot, 'current'), { force: true });
  await fs.symlink(link, path.join(runtimeRoot, 'current'));

  return link;
}

for (const kind of ['corrupt', 'incompatible']) {
  test(`непригодный прежний current (${kind}) не валит обновление, а откат его снимает`, async (t) => {
    const f = await fixture(t);

    await f.update(f.intermediateSha, 'v0.2.0');

    const runtimeRoot = path.join(f.root, 'server/runtime/deepseek');
    const current = path.join(runtimeRoot, 'current');
    const broken = await unusableCurrent(f.root, runtimeRoot, kind);
    const failed = await f.update(f.embeddedSha, 'v0.3.0', { reject: true, failPhase: 'runtime' });

    assert.equal(failed.job.error.code, 'publish_failed');
    assert.equal(failed.job.recovery, 'previous-checkout-restored');
    assert.equal(failed.job.previousRuntimeBuildId, null);
    assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), f.intermediateSha);
    await assert.rejects(fs.lstat(current), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(runtimeRoot, 'publish-pending.json')), { code: 'ENOENT' });

    await fs.rm(path.join(runtimeRoot, '.publish-lock'), { recursive: true });
    await fs.symlink(broken, current);

    const finished = await f.update(f.embeddedSha, 'v0.3.0');
    const log = await fs.readFile(`${finished.state}.log`, 'utf8');

    assert.equal(finished.job.status, 'restarting');
    assert.equal(finished.job.previousRuntimeBuildId, null);
    assert.equal(await fs.readlink(current), `builds/${finished.job.expectedRuntimeBuildId}`);
    assert.match(log, new RegExp(`${finished.job.id} previous-runtime-unusable deepseek_runtime_${kind}`));
  });
}

test('чужой или нечитаемый publish-pending останавливает обновление до установки зависимостей', async (t) => {
  const f = await fixture(t);

  await f.update(f.intermediateSha, 'v0.2.0');

  const runtimeRoot = path.join(f.root, 'server/runtime/deepseek');
  const pendingFile = path.join(runtimeRoot, 'publish-pending.json');
  const previous = path.join(f.root, 'server/.state/previous-generation');

  await writeDeepSeekArtifactFixture(previous, 'previous');
  await publishDeepSeekGeneration(previous, runtimeRoot);

  const current = await fs.readlink(path.join(runtimeRoot, 'current'));
  const foreign = randomUUID();
  const cases = [
    {
      body: JSON.stringify({ jobId: foreign, workerPid: 2147483647 }),
      hint: `node server/scripts/prepareDeepSeekRuntime.mts --recover-job ${foreign}`,
    },
    {
      body: '{"jobId":',
      hint: 'publish-pending.json',
    },
  ];

  for (const { body, hint } of cases) {
    await fs.writeFile(pendingFile, body, { mode: 0o600 });

    const result = await f.update(f.embeddedSha, 'v0.3.0', { reject: true });

    assert.equal(result.job.error.code, 'runtime_publication_pending');
    assert.ok(result.job.error.message.includes(hint), result.job.error.message);
    assert.deepEqual(result.npmCalls, []);
    assert.equal(await fs.readFile(pendingFile, 'utf8'), body);
    assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), f.intermediateSha);
    assert.equal(await fs.readlink(path.join(runtimeRoot, 'current')), current);
  }
});

test('чужой pending, появившийся во время сборки, переживает отказ worker', async (t) => {
  const f = await fixture(t);

  await f.update(f.intermediateSha, 'v0.2.0');

  const runtimeRoot = path.join(f.root, 'server/runtime/deepseek');
  const pendingFile = path.join(runtimeRoot, 'publish-pending.json');
  const previous = path.join(f.root, 'server/.state/previous-generation');

  await writeDeepSeekArtifactFixture(previous, 'previous');
  await publishDeepSeekGeneration(previous, runtimeRoot);

  const current = await fs.readlink(path.join(runtimeRoot, 'current'));
  const body = JSON.stringify({ jobId: randomUUID(), workerPid: 2147483647 });
  const result = await f.update(f.embeddedSha, 'v0.3.0', { reject: true, pendingDuringBuild: body });

  assert.equal(result.job.error.code, 'runtime_publication_pending');
  assert.ok(result.npmCalls.includes('run build'));
  assert.equal(await fs.readFile(pendingFile, 'utf8'), body);
  assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), f.intermediateSha);
  assert.equal(await fs.readlink(path.join(runtimeRoot, 'current')), current);
});

test('прерванный installed worker сохраняет pending и recover блокирует новые prompts', async (t) => {
  const f = await fixture(t);

  await f.update(f.intermediateSha, 'v0.2.0');

  const runtimeRoot = path.join(f.root, 'server/runtime/deepseek');
  const source = path.join(f.root, 'server/.state/previous');
  const a = await writeDeepSeekArtifactFixture(source, 'previous');

  await publishDeepSeekGeneration(source, runtimeRoot);

  const result = await f.update(f.embeddedSha, 'v0.3.0', { interrupt: true });
  const pendingFile = path.join(runtimeRoot, 'publish-pending.json');
  const pending = await fs.readFile(pendingFile, 'utf8');

  // Маркер записан целиком через rename: приватный режим и никаких временных файлов рядом.
  assert.equal((await fs.stat(pendingFile)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(runtimeRoot)).sort(), ['builds', 'current', 'publish-pending.json']);
  assert.equal(JSON.parse(pending).jobId, result.job.id);
  assert.equal(result.job.publicationStage, 'applying-checkout');
  assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), f.intermediateSha);
  assert.equal(await fs.readlink(path.join(runtimeRoot, 'current')), `builds/${a.buildId}`);

  result.job.updatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  await writePersistentState(result.state, { job: result.job });

  const releases = new CockpitReleaseService({ rootDir: f.root, statePath: result.state });
  const manager = new CockpitUpdateManager({
    releases,
    rootDir: f.root,
    statePath: result.state,
  });

  t.after(() => releases.stop());
  await manager.recover();
  assert.equal((await manager.getJob()).error.code, 'worker_disappeared');
  assert.equal(await fs.readFile(pendingFile, 'utf8'), pending);
  assert.throws(() => resolveDeepSeekRuntime({
    deepseekRuntimeMode: 'embedded',
    deepseekGenerationRoot: runtimeRoot,
  }), { code: 'deepseek_runtime_publish_pending' });
});
