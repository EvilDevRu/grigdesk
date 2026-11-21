import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { stageFactoryCandidate } from '../../server/scripts/binary/factoryCandidate.mts';
import { readFactoryGoDescriptor } from '../../server/src/lib/factoryGoDescriptor.ts';
import { expectAttempt, prepareCommandServer } from './helpers/factoryGoRuntime.mts';

const repo = fileURLToPath(new URL('../..', import.meta.url));

const launch = {
  profile: 'demo-profile',
  route: 'command',
  title: 'Нативная проба фабрики',
  description: 'Физические каталоги тестовой установки',
  acceptanceCriteria: ['Один результат'],
  sourceUrl: 'https://example.test/tasks/71',
};

test('Linux: перенесённый Go-движок проходит ворота, читает журнал и обрабатывает Stop', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-native-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const candidate = process.env.FACTORY_NATIVE_BINARY || path.join(root, 'source-factory');

  if (!process.env.FACTORY_NATIVE_BINARY) {
    const options = [
      'build', '-trimpath', '-buildvcs=false', '-o', candidate, './utilities/factory/cmd/factory',
    ];
    const rc = spawnSync('go', options, {
      cwd: repo,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, CGO_ENABLED: '0' },
    });

    assert.equal(rc.status, 0, rc.stderr);
  }

  const install = path.join(root, 'отдельная установка');
  const pack = path.join(install, 'generation-b');

  await fs.mkdir(pack, { recursive: true });

  const meta = await stageFactoryCandidate({
    root: pack,
    binary: candidate,
    profileAbi: path.join(repo, 'engine/lib/delivery_contract.py'),
    os: process.platform,
    arch: process.arch,
  });
  const moved = path.join(install, 'generation-b-verified');

  await fs.rename(pack, moved);
  assert.deepEqual(readFactoryGoDescriptor(moved), meta);

  const bin = path.join(moved, meta.path);
  const engineHome = path.dirname(path.dirname(bin));
  const gateRoot = path.join(root, 'gate');
  const fx = await prepareCommandServer(t, gateRoot, bin);
  const env = {
    HOME: gateRoot,
    PATH: '/usr/bin:/bin',
    FACTORY_HOME: engineHome,
    FACTORY_PROFILES_DIR: fx.config.profilesDir,
    FACTORY_CONTROL_ROOT: fx.config.factoryControlDir,
    FACTORY_STATE: fx.config.stateDir,
    FACTORY_CONFIG_ROOT: fx.config.factoryConfigRoot,
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const profile = spawnSync(bin, ['profile-check', launch.profile, '--quick'], {
    cwd: moved,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.equal(profile.status, 0, profile.stderr || profile.stdout);

  const first = await fx.open({ factoryHome: engineHome });
  const started = await first.inject({
    method: 'POST',
    url: '/api/tasks/71/launch',
    payload: launch,
  });

  assert.equal(started.json().outcome, 'launched', started.body);
  await fs.writeFile(path.join(gateRoot, 'release-command'), '');

  const atGate = await expectAttempt(fx.adapter, (value) => value.cursor?.node === 'gate_accept');

  await first.close();

  const reopened = await fx.open({ factoryHome: engineHome });
  const decision = await reopened.inject({
    method: 'POST',
    url: '/api/tasks/71/gate/GATE_ACCEPT/approve',
    payload: {
      attempt: atGate.attempt,
      profile: launch.profile,
      comment: 'Принято',
    },
  });

  assert.equal(decision.json().resumed, true, decision.body);

  const terminal = await expectAttempt(fx.adapter, (value) => value.terminal === 'completed');

  assert.equal(terminal.attempt, atGate.attempt);
  assert.equal(terminal.routeHash, atGate.routeHash);
  assert.equal(await fs.readFile(path.join(gateRoot, 'command.count'), 'utf8'), '1\n');

  const history = spawnSync(bin, [
    '71', 'work-time', '--profile', launch.profile, '--attempt', terminal.attempt,
    '--routes-dir', fx.config.routesDir,
  ], {
    env,
    cwd: install,
    encoding: 'utf8',
    timeout: 15_000,
  });

  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /^work_time_s=\d+\n/mu);
  assert.deepEqual(readFactoryGoDescriptor(moved), meta);

  const stopRoot = path.join(root, 'stop');
  const stopFx = await prepareCommandServer(t, stopRoot, bin);
  const stopping = await stopFx.open({ factoryHome: engineHome });
  const second = await stopping.inject({
    method: 'POST',
    url: '/api/tasks/71/launch',
    payload: launch,
  });

  assert.equal(second.json().outcome, 'launched', second.body);

  const stopped = await stopping.inject({
    method: 'POST', url: '/api/tasks/71/stop',
  });

  assert.equal(stopped.json().outcome, 'stopped', stopped.body);

  const { registry } = await stopFx.adapter.readRegistry('71');

  assert.equal(registry.STOPPED_SIGNAL, '1');
  assert.equal(stopFx.adapter.isDaemonAlive(registry.ORCH_PID, '71'), false);
  assert.equal(await fs.readFile(path.join(stopRoot, 'command.count'), 'utf8'), '1\n');

  const exit = await fs.readFile(path.join(stopFx.config.stateDir, 't71.launch.log'), 'utf8');

  assert.match(exit, /^rc=130$/mu);

  const report = {
    platform: process.platform,
    arch: process.arch,
    abi: meta.kind,
    sha256: meta.sha256,
    fixture: 'command-gate-resume-stop',
    profileCheck: profile.status,
    historyRead: history.status,
    started: started.statusCode,
    gate: decision.statusCode,
    stop: stopped.statusCode,
    stoppedEngineRC: 130,
    attempt: terminal.attempt,
    routeHash: terminal.routeHash,
    sequence: terminal.stageIdentity?.sequence,
    commandEffects: 1,
    report: 'ENGINE PASS',
  };
  const encoded = JSON.stringify(report);
  const reportPath = process.env.FACTORY_NATIVE_REPORT;

  if (reportPath && path.isAbsolute(reportPath)) {
    await fs.writeFile(reportPath, encoded + '\n', { mode: 0o600 });
    await fs.writeFile(reportPath + '.profile.txt', profile.stdout, { mode: 0o600 });
    await fs.writeFile(reportPath + '.stop.txt', exit, { mode: 0o600 });
  }

  t.diagnostic(encoded);
});
