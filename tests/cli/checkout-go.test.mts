import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createSandbox } from './helpers/sandbox.mts';
import { buildLog, chooseBuild, launchBuild, terminalBuildFixture } from './helpers/buildFixture.mts';
import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';
import { DAY, oldTree, retentionFixture } from '../helpers/deepseekRetentionFixture.mts';

test('CTL-GO-01: состояние берётся из указанного физического checkout', async (t) => {
  const fixture = await createSandbox(t, { go: true });
  const other = await createSandbox(t, { go: true });

  fixture.unit({
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'running',
    Result: 'success',
    WorkingDirectory: path.join(fixture.root, 'server'),
  });
  other.unit({
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'running',
    Result: 'success',
    WorkingDirectory: path.join(fixture.root, 'server'),
  });
  await fixture.serve('grigdesk');
  await other.serve('grigdesk');

  const own = await fixture.run(['status', '--json']);
  const foreign = await other.run(['status', '--json']);

  assert.equal(own.code, 0, own.stderr);
  assert.equal(foreign.code, 0, foreign.stderr);
  assert.equal(JSON.parse(own.stdout).server.state, 'ready');
  assert.equal(JSON.parse(own.stdout).server.managed, true);
  assert.equal(JSON.parse(foreign.stdout).server.state, 'mismatch');
  assert.match(JSON.parse(foreign.stdout).server.reason, /другую копию/u);
});

test('CTL-GO-RELAY: статус читает связи сервера без обращения к Docker', async (t) => {
  const fixture = await createSandbox(t, { go: true });

  await fixture.serve('grigdesk', {
    relays: [{ name: 'Дом', link: { state: 'online' } }],
  });

  const result = await fixture.run(['relay', 'status', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { relay: { links: [{ name: 'Дом', state: 'online' }] } });

  for (const action of ['start', 'stop', 'restart', 'logs']) {
    const removed = await fixture.run(['relay', action]);

    assert.equal(removed.code, 2, removed.stderr);
  }

  assert.ok(fixture.calls().every((call) => !call.startsWith('docker ')));
});

test('CTL-GO-02: меню запускает web-сборку, сохраняет вывод и показывает результат', async (t) => {
  const fixture = await terminalBuildFixture(t, true);
  const session = launchBuild(t, fixture, 'web', true);

  await chooseBuild(session, 'web');
  await session.wait(/Сборка завершена|Сборка выполнена/iu);

  const log = await buildLog(fixture);

  assert.match(log.text, /fixture-out.*build/u);
  assert.match(log.text, /fixture-err/u);
});

test('CTL-GO-03: события сборки идут по fd 3 и не загрязняют stdout', async (t) => {
  const fixture = await terminalBuildFixture(t, true);
  const [file, ...argv] = fixture.argv(['build', 'web']);
  const child = spawn(file!, argv, {
    env: { ...fixture.env, GRIGDESK_CTL_BUILD_OBSERVED: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let events = '';

  child.stdout!.on('data', (data) => stdout += data);
  child.stderr!.resume();
  child.stdio[3]!.on('data', (data) => events += data);

  const [rc] = await once(child, 'close');

  assert.equal(rc, 0);
  assert.match(stdout, /Собран веб/u);
  assert.doesNotMatch(stdout, /start\t|end\t/u);
  assert.equal(events, 'start\tweb.dependencies\nend\tweb.dependencies\t0\n'
    + 'start\tweb.build\nend\tweb.build\t0\n');
});

test('CTL-GO-04: уборка не трогает живой Node lock и внешнюю цель ссылки', async (t) => {
  const fixture = await createSandbox(t, { go: true });
  const retention = await retentionFixture(t);

  await mkdir(retention.artifacts, { recursive: true });

  const protectedPath = await oldTree(retention.artifacts, 'locked', 87, Date.now() - 14 * DAY);
  const deletable = await oldTree(retention.artifacts, 'expired', 248, Date.now() - 14 * DAY);
  const external = await oldTree(fixture.home, 'external', 31, Date.now() - 14 * DAY);
  const lock = await acquireDirectoryLock(protectedPath + '.lock');

  t.after(() => lock.release());
  await symlink(external, path.join(retention.artifacts, 'linked'));

  const env = { GRIGDESK_ARTIFACTS_DIR: retention.artifacts };
  const preview = await fixture.run(['artifacts-cleanup', '--dry-run', '--json'], env);

  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).wouldDeleteBytes, 248);
  await stat(deletable);

  const result = await fixture.run(['artifacts-cleanup', '--json'], env);
  const report = JSON.parse(result.stdout);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(report.freedBytes, 248);
  assert.equal(report.entries.find((entry: { path: string }) => entry.path === 'locked').reason, 'locked');
  await stat(protectedPath);
  await stat(external);
  await assert.rejects(() => stat(deletable), { code: 'ENOENT' });
});
