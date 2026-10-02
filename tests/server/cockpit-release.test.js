import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDeepSeekArtifactFixture } from '../helpers/deepSeekArtifactFixture.mts';
import { publishDeepSeekGeneration } from '../../tools/deepseekRuntimePublication.ts';

import {
  CockpitReleaseService,
  assertReleaseNodeRuntime,
  assertReleasePublishContract,
  compareSemVer,
  parseRemoteTags,
  parseSemVer,
  releaseUrl,
  writePersistentState,
} from '../../server/src/lib/cockpitRelease.ts';

const SHA_A = '1'.repeat(40);
const SHA_B = '2'.repeat(40);

test('embedded релиз требует publish contract установленного worker до merge', async () => {
  await assertReleasePublishContract(fileURLToPath(new URL('../../', import.meta.url)),
    process.env.COCKPIT_RELEASE_PUBLISH_CONTRACT);
});

// Старый worker запускает этот JS-файл в новом дереве обычным node --test.
// До merge и замены web/dist он обязан узнать, сможет ли новый сервер стартовать.
test('целевой релиз запускается текущим Node без флагов старого сервера', async () => {
  await assertReleaseNodeRuntime(fileURLToPath(new URL('../../', import.meta.url)), {
    required: true,
  });
});

test('старый релиз без gate применим, а новый smoke требует проверку', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-runtime-legacy.'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await assertReleaseNodeRuntime(root);
  await assert.rejects(assertReleaseNodeRuntime(root, { required: true }), {
    safeCode: 'node_runtime_check_unavailable',
  });
});

test('runtime probe не наследует NODE_OPTIONS и сообщает отказ целевого gate', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-runtime-probe.'));
  const gateDir = path.join(root, 'server', 'src', 'lib');
  const oldOptions = process.env.NODE_OPTIONS;

  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    if (oldOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = oldOptions;
    }
  });
  await mkdir(gateDir, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(gateDir, 'nodeVersion.ts'), [
    'export function assertSupportedNode(): void {',
    '  if (process.env.NODE_OPTIONS || process.execArgv.includes("--experimental-strip-types")) {',
    '    throw new Error("probe унаследовал обход проверки runtime");',
    '  }',
    '  throw new Error("целевой релиз требует другой Node");',
    '}',
  ].join('\n'));
  process.env.NODE_OPTIONS = '--experimental-strip-types';

  await assert.rejects(assertReleaseNodeRuntime(root), (error) => {
    assert.equal(error.safeCode, 'node_runtime_unsupported');
    assert.match(error.message, /целевой релиз требует другой Node/);
    assert.doesNotMatch(error.message, /унаследовал обход/);

    return true;
  });
});

test('strict SemVer accepts releases and rejects prefixes, leading zeroes and prereleases', () => {
  assert.deepEqual(parseSemVer('0.1.0'), { major: 0, minor: 1, patch: 0 });
  assert.deepEqual(parseSemVer('12.30.4\n'), { major: 12, minor: 30, patch: 4 });
  for (const bad of ['v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3-beta', '1.2.3+build']) {
    assert.equal(parseSemVer(bad), null, bad);
  }
  assert.equal(compareSemVer('1.10.0', '1.9.9') > 0, true);
  assert.equal(compareSemVer('2.0.0', '10.0.0') < 0, true);
});

test('remote parser uses peeled commit and ignores lightweight/prerelease tags', () => {
  const tags = parseRemoteTags([
    `${SHA_A}\trefs/tags/v0.2.0`,
    `${SHA_B}\trefs/tags/v0.2.0^{}`,
    `${'3'.repeat(40)}\trefs/tags/v0.10.0`,
    `${'4'.repeat(40)}\trefs/tags/v0.10.0^{}`,
    `${'5'.repeat(40)}\trefs/tags/v1.0.0-beta`,
    `${'6'.repeat(40)}\trefs/tags/v9.0.0`,
  ].join('\n'));
  assert.deepEqual(tags.map((tag) => tag.tag), ['v0.2.0', 'v0.10.0']);
  assert.equal(tags[0].sha, SHA_B);
  assert.equal(tags[0].tagObjectSha, SHA_A);
});

test('release URL only exposes a credential-free GitHub link', () => {
  assert.equal(releaseUrl('git@github.com:EvilDevRu/ai-cockpit.git', 'v1.2.3'),
    'https://github.com/EvilDevRu/ai-cockpit/releases/tag/v1.2.3');
  assert.equal(releaseUrl('https://token@github.com/org/repo.git', 'v1.2.3'),
    'https://github.com/org/repo/releases/tag/v1.2.3');
  assert.equal(releaseUrl('ssh://private.example/repo.git', 'v1.2.3'), null);
  assert.equal(releaseUrl('git@github.com:org/repo.git', '../../main'), null);
});

function fakeRunner({ remoteResult, calls }) {
  return async (_file, args) => {
    calls.push(args);
    const command = args.slice(2);
    const key = command[0];
    if (key === 'rev-parse') return { code: 0, stdout: `${SHA_A}\n`, stderr: '' };
    if (key === 'symbolic-ref') return { code: 0, stdout: 'main\n', stderr: '' };
    if (key === 'status') return { code: 0, stdout: '', stderr: '' };
    if (key === 'tag') return { code: 0, stdout: '', stderr: '' };
    if (key === 'describe') return { code: 0, stdout: `${SHA_A.slice(0, 7)}\n`, stderr: '' };
    if (key === 'merge-base') return { code: 128, stdout: '', stderr: 'unknown commit' };
    if (key === 'ls-remote') return remoteResult;
    if (key === 'remote') return { code: 0, stdout: 'git@github.com:org/repo.git\n', stderr: '' };
    throw new Error(`unexpected git command: ${command.join(' ')}`);
  };
}

test('GET status is local; concurrent checks share one remote operation and preserve last success on error', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-release.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'server', '.state'), { recursive: true });
  await writeFile(path.join(root, 'VERSION'), '0.1.0\n');
  const statePath = path.join(root, 'server', '.state', 'cockpit-update.json');
  await writePersistentState(statePath, {
    releaseCheck: {
      latest: { version: '0.1.0', tag: 'v0.1.0', sha: SHA_A, url: null },
      checkedAt: '2026-01-01T00:00:00.000Z', checkError: null,
    },
  });
  const calls = [];
  let remoteCalls = 0;
  let resolveRemote;
  let remoteResult = new Promise((resolve) => { resolveRemote = resolve; });
  const base = fakeRunner({ remoteResult: null, calls });
  const runner = async (file, args, options) => {
    if (args[2] === 'ls-remote') { remoteCalls += 1; return remoteResult; }
    return base(file, args, options);
  };
  const service = new CockpitReleaseService({ rootDir: root, statePath, runner });

  const status = await service.getStatus();
  assert.equal(status.latest.tag, 'v0.1.0');
  assert.equal(calls.some((args) => args.includes('ls-remote')), false, 'local GET did not touch remote');

  const one = service.checkRemote();
  const two = service.checkRemote();
  resolveRemote({
    code: 0,
    stdout: `${'7'.repeat(40)}\trefs/tags/v0.2.0\n${SHA_B}\trefs/tags/v0.2.0^{}\n`,
    stderr: '',
  });
  const checked = await one;
  await two;
  assert.equal(checked.latest.tag, 'v0.2.0');
  assert.equal(remoteCalls, 1, 'concurrent checks use one ls-remote process');

  remoteResult = Promise.resolve({ code: 1, stdout: '', stderr: 'secret remote failure', timedOut: false });
  const failed = await service.checkRemote();
  assert.equal(failed.latest.tag, 'v0.2.0', 'last successful release remains visible');
  assert.equal(failed.checkError.code, 'remote_unavailable');
  assert.doesNotMatch(JSON.stringify(failed), /secret remote failure/);
  assert.equal((calls.filter((args) => args.includes('remote'))).length, 1);
  assert.equal((await readFile(statePath, 'utf8')).includes('secret remote failure'), false);
});

test('exact release tag must match root VERSION', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-version-tag.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'VERSION'), '0.1.0\n');
  const calls = [];
  const base = fakeRunner({ remoteResult: null, calls });
  const runner = async (file, args, options) => {
    if (args[2] === 'tag') return { code: 0, stdout: 'v0.2.0\n', stderr: '' };
    if (args[2] === 'describe') return { code: 0, stdout: 'v0.2.0-0-g1111111\n', stderr: '' };
    return base(file, args, options);
  };
  const service = new CockpitReleaseService({
    rootDir: root, statePath: path.join(root, 'state.json'), runner,
  });
  const status = await service.getStatus();
  assert.equal(status.running.version, 'v0.2.0');
  assert.equal(status.running.versionTagMismatch, true);
  assert.equal(status.checkout.versionTagMismatch, true);
  assert.ok(status.installBlockReasons.includes('version_tag_mismatch'));
});

test('the old process cannot confirm apply of the same SHA before it actually restarts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-process-instance.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'VERSION'), '0.1.0\n');
  const statePath = path.join(root, 'state.json');
  const calls = [];
  const runner = fakeRunner({ remoteResult: null, calls });
  const oldProcess = new CockpitReleaseService({ rootDir: root, statePath, runner });
  const initial = await oldProcess.getStatus();
  await writePersistentState(statePath, {
    job: {
      id: 'same-sha-job', kind: 'apply', status: 'restarting', stage: 'restarting',
      targetSha: SHA_A, previousRunningInstanceId: initial.running.instanceId,
    },
  });
  oldProcess.invalidate();
  assert.equal((await oldProcess.getStatus({ fresh: true })).job.status, 'restarting');

  const newProcess = new CockpitReleaseService({ rootDir: root, statePath, runner });
  assert.equal((await newProcess.getStatus({ fresh: true })).job.status, 'done');
  oldProcess.stop();
  newProcess.stop();
});

test('новый running SHA без ожидаемого целого runtime не подтверждает обновление', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-runtime-readiness-'));
  const statePath = path.join(root, 'state.json');
  const runtimeRoot = path.join(root, 'server/runtime/deepseek');

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'VERSION'), '0.1.0\n');

  const a = await writeDeepSeekArtifactFixture(path.join(root, 'A'), 'A');

  await publishDeepSeekGeneration(path.join(root, 'A'), runtimeRoot);

  for (const [scenario, expected] of [['mismatch', 'f'.repeat(64)], ['corrupt', a.buildId]]) {
    await writePersistentState(statePath, { job: {
      id: `readiness-${scenario}`,
      status: 'restarting',
      targetSha: SHA_A,
      expectedRuntimeBuildId: expected,
    } });

    if (scenario === 'corrupt') {
      await writeFile(path.join(runtimeRoot, 'builds', a.buildId, 'entry.mjs'), 'corrupt');
    }

    const service = new CockpitReleaseService({
      rootDir: root,
      statePath,
      runner: fakeRunner({ remoteResult: null, calls: [] }),
    });
    const status = await service.getStatus({ fresh: true });

    assert.equal(status.job.status, 'failed');
    assert.equal(status.job.error.code, scenario === 'mismatch'
      ? 'runtime_build_mismatch' : 'runtime_readiness_failed');
    service.stop();
  }
});
