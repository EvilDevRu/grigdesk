import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acceptanceInputs, awaitAcceptance, evaluateWindow, execute, freeAcceptancePort, platformFixture,
  verifyAcceptanceModes,
  verifyAcceptanceVersions, writePlatformAcceptance,
} from '../helpers/platformReleaseAcceptance.mts';
import {
  configureDecisionApi, macosRuntimePinFixture, prepareRuntime, seedRuntimePinGate,
} from '../helpers/macosRuntimePinFixture.mts';
import {
  verifyArbiterDrainAdmission, verifyFactoryConfirmAdmission, verifyFactoryLaunchRecovery,
} from '../helpers/macosFactoryDrainAcceptance.mts';
import {
  verifyPackagedEngineExternalLease, verifyPackagedEngineStatusChannel, verifyPackagedEngineUsage,
  verifyPackagedHttpEngineStop,
} from '../helpers/macosFactoryEngineAcceptance.mts';
import { interruptVerifiedMacService, verifyInactiveLaunchAgent }
  from '../helpers/macosDistributionCancellation.mts';
import { verifyDistributionArtifacts } from '../../tools/releaseArtifactVerification.mts';
import { assertCandidateFiles } from '../../tools/platformCandidate.mts';
import { completeRunRecord, createRunRecord, readRunRecord } from '../../tools/distributionRuns.mts';
import { readDarwinServiceRegistration } from '../../shared/node/launchdInstalledService.ts';
import { readInstallation } from '../../shared/node/installedLayout.ts';
import { decodePairing } from '../../shared/client/pairingPayload.ts';
import { MAC_APP_EXECUTABLE } from '../../shared/node/bundleLayout.ts';
import { updateProcessAlive } from '../../shared/node/installedServer.ts';
import { readUpdateProcess } from '../../shared/node/updateProcessOwner.ts';
import { configureDarwinBuildProcessHelper } from '../../shared/node/processIdentity.ts';
import { removePrivateTree } from '../../shared/node/files.ts';
import { sha256File } from '../../shared/node/hash.ts';

const errorText = (value: unknown) => String((value as { stderr?: string } | null)?.stderr ?? value);
const barePath = '/usr/bin:/bin';

type Box = Awaited<ReturnType<typeof platformFixture>>;
type DesktopOwner = Awaited<ReturnType<typeof readUpdateProcess>>;

/**
 * Использует обычное действие окна после того, как renderer заметил ready.
 * Ответ не держит CDP открытым во время выхода старого приложения.
 */
async function applyFromWindow(endpoint: string) {
  await awaitAcceptance(async () => (await evaluateWindow(endpoint,
    "fetch('/__shell/state').then(r => r.json()).then(s => s.applicationUpdate?.job?.stage)") === 'ready')
    || null, 'mac_candidate_ready_missing');
  await evaluateWindow(endpoint, `(() => {
    void fetch('/__shell/updates/apply', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: '{"confirmed":true}',
    });
    return true;
  })()`);
}

/**
 * Новый executable подтверждается exact PID и стартом из штатной записи запуска.
 * Дочерний maintenance до execve и старое окно из другого поколения не подходят.
 */
async function waitForUpdatedDesktop(box: Box, relative: string): Promise<DesktopOwner> {
  const executable = path.join(box.root, relative, MAC_APP_EXECUTABLE);
  const maintenance = path.join(box.root, 'update/maintenance');

  return awaitAcceptance(async () => {
    const started = await box.state('update/desktop-launch-process.json');

    if (started.intent.relative !== relative) {
      return null;
    }

    const owner = await readUpdateProcess(started.process.pid, maintenance);

    return owner.executable === executable && owner.starttime === started.process.starttime ? owner : null;
  }, 'mac_candidate_desktop_exec_missing', 120_000);
}

/**
 * Закрывает только собственное проверочное окно из той же запущенной инкарнации.
 * Отсутствие совпадения до сигнала сохраняет другой процесс.
 */
async function closeFixtureDesktop(owner: DesktopOwner) {
  if (await updateProcessAlive(owner)) {
    process.kill(owner.pid, 'SIGTERM');
    await awaitAcceptance(async () => !await updateProcessAlive(owner) || null,
      'mac_candidate_fault_desktop_cleanup', 30_000);
  }
}

/**
 * Терминальная запись публикуется перед выходом worker. Следующая команда ctl
 * должна начинаться после выхода этой exact инкарнации и освобождения lock.
 */
async function waitForApplyWorkerExit(box: Box) {
  const worker = await box.state('update/worker-process.json');

  await awaitAcceptance(async () => !await updateProcessAlive(worker.process) || null,
    'mac_candidate_apply_worker_exit_missing', 30_000);
}

/**
 * Посылает обычный App Quit только процессу своей установки через AppKit.
 * Номер процесса и физический executable проверяются перед отправкой.
 */
async function requestAppQuit(owner: DesktopOwner) {
  assert.equal(await updateProcessAlive(owner), true);
  await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
    ObjC.import('AppKit');
    function run(argv) {
      const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
      if (!app || app.terminated || ObjC.unwrap(app.executableURL.path) !== argv[1]) {
        throw new Error('candidate_window_owner_changed');
      }
      if (!app.terminate) throw new Error('candidate_window_quit_not_dispatched');
    }
  `, String(owner.pid), owner.executable], { timeout: 15_000 });
}

test('Проверка готового macOS кандидата', { timeout: 4_200_000 }, async (t) => {
  const input = acceptanceInputs('darwin');
  const passed: string[] = [];
  const engineChecks = new Set<string>();
  const drainChecks = new Set<string>();
  const runtime: Record<string, unknown> = {};
  let versions: Awaited<ReturnType<typeof verifyAcceptanceVersions>>;

  await configureDarwinBuildProcessHelper();

  await t.test('MAC-VERIFY-BYTES', async (testCase) => {
    versions = await verifyAcceptanceVersions(input);

    const files = await assertCandidateFiles(input.candidate, 'darwin-arm64', 'input');
    const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gd-tamper-'));

    testCase.after(() => fs.rm(directory, { recursive: true, force: true }));

    for (const name of files) {
      await fs.copyFile(path.join(input.candidate, name), path.join(directory, name));
    }

    const changed = await fs.open(path.join(directory, 'server.tar.gz'), 'r+');

    try {
      const head = Buffer.alloc(1);

      await changed.read(head, 0, 1, 0);
      head[0] = head[0]! ^ 1;
      await changed.write(head, 0, 1, 0);
      await changed.sync();
    } finally {
      await changed.close();
    }

    await assert.rejects(verifyDistributionArtifacts(directory, input.trust),
      /release_archive_integrity_invalid/u);
    passed.push('MAC-VERIFY-BYTES');
  });

  await t.test('MAC-VERIFY-MODES', async (testCase) => {
    const reports = await verifyAcceptanceModes(testCase, input);

    for (const proof of reports) {
      assert.equal(proof.guiAcceptance, 'not-performed');

      if (proof.mode !== 'remote') {
        const receipt = await readInstallation(proof.root);
        const registration = await readDarwinServiceRegistration(receipt);

        assert.equal(registration.env.GRIGDESK_HOME, receipt.dataHome);
        assert.equal(registration.argv[0], '/usr/bin/env');
        assert.equal(registration.argv[1], '-i');
      }
    }

    const box = await platformFixture(testCase, 'remote');
    const program = path.join(box.homeRoot, 'Program');
    const alias = path.join(box.homeRoot, 'program');
    const caseWitness = path.join(box.homeRoot, 'Case Witness');

    await fs.mkdir(caseWitness);
    assert.equal((await fs.stat(caseWitness)).ino,
      (await fs.stat(path.join(box.homeRoot, 'case witness'))).ino);

    for (const [data, root] of [
      [path.join(box.homeRoot, 'data space'), program],
      [box.home, program],
      [alias, program],
      [path.join(alias, 'data'), program],
      [alias, path.join(program, 'nested')],
    ] as const) {
      await assert.rejects(box.install(input.candidate, { dataHome: data, root }),
        (error) => /absolut|абсолютн|папка данных|Invalid argument|вложен/iu.test(errorText(error)));
      await assert.rejects(fs.lstat(root + '.installing.json'), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(path.join(root, 'current.json')), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(path.join(box.bin, 'grigdesk')), { code: 'ENOENT' });
    }

    passed.push('MAC-VERIFY-MODES');
  });

  await t.test('MAC-VERIFY-PROBES', async (testCase) => {
    const box = await platformFixture(testCase, 'local');

    await box.install(input.candidate);

    const pointer = await box.state('current.json');
    const inventory = [
      ['grigdesk-server', ['--runtime-info', '--json']],
      ['tracker', ['--version']],
      ['pipeline', ['--version']],
      ['routes', ['--version']],
      ['voice', ['version']],
      ['grigdesk-relay', ['--version']],
      ['deepseek', ['--runtime-info', '--json']],
    ] as const;
    const env = {
      ...box.env,
      PATH: barePath,
      GRIGDESK_HOME: box.dataHome,
    };

    for (const [file, argv] of inventory) {
      const binary = path.join(box.root, pointer.server, 'bin', file);
      const { stdout } = await execute('/usr/bin/file', ['-b', binary], { env });

      assert.match(stdout, /Mach-O.*arm64/u);
      await execute('/usr/bin/codesign', ['--verify', '--strict', binary], { env });

      const version = await execute(binary, [...argv], { env, timeout: 60_000 });

      assert.ok(version.stdout.trim());

      if (argv.some((arg) => arg === '--json')) {
        const info = JSON.parse(version.stdout);

        assert.equal(info.platform ?? info?.runtime?.platform, 'darwin');
        assert.equal(info.arch ?? info?.runtime?.arch, 'arm64');
      } else {
        assert.match(version.stdout, /darwin arm64/u);
      }
    }

    const desktop = await execute(path.join(box.bin, 'grigdesk'), ['--grigdesk-release-probe'], {
      env,
      timeout: 60_000,
    });

    assert.equal(JSON.parse(desktop.stdout).version, versions!.current);
    passed.push('MAC-VERIFY-PROBES');
  });

  await t.test('MAC-VERIFY-LAUNCHER', async (testCase) => {
    const box = await platformFixture(testCase, 'server');

    await box.install(input.candidate);
    runtime.launchdBeforeKickstart = await verifyInactiveLaunchAgent(box);

    const stopped = await box.ctl(['server', 'status', '--json']);
    const injected = path.join(box.home, 'dirty-launcher.cjs');
    const marker = path.join(box.home, 'dirty-launcher.output');

    assert.equal(JSON.parse(stopped.stdout).running, false);
    await fs.writeFile(injected,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n`, { mode: 0o600 });
    await box.ctl(['server', 'start', '--wait'], {
      NODE_OPTIONS: '--require=' + injected,
      GRIGDESK_HOME: path.join(box.home, 'unexpected-data-home'),
    });
    await assert.rejects(fs.lstat(marker), { code: 'ENOENT' });

    const live = JSON.parse((await box.ctl(['server', 'status', '--json'])).stdout);
    const api = (await box.api('/api/system/runtime-identity')).body;

    assert.ok(live.running && ['service', 'manual'].includes(live.kind));
    assert.equal(live.instanceId, api.instanceId);
    assert.equal(live.process.pid, api.pid);
    assert.notEqual(live.launcher.pid, api.pid);

    const refusedStop = await box.api('/api/tasks/900001/stop', {});

    assert.equal(refusedStop.status, 409);
    assert.deepEqual(refusedStop.body, { error: 'release_activity_unknown' });
    assert.equal((await box.api('/api/system/runtime-identity')).body.instanceId, live.instanceId);

    const receipt = await readInstallation(box.root);
    const registration = await readDarwinServiceRegistration(receipt);
    const saved = await fs.readFile(registration.receipt.plist);

    try {
      const mismatched = saved.toString('utf8').replace('/usr/bin/env', '/bin/false');

      await fs.writeFile(registration.receipt.plist, mismatched);
      await assert.rejects(box.ctl(['server', 'stop']),
        (error) => /conflict|foreign_service/u.test(errorText(error)));
      assert.equal((await box.api('/api/system/runtime-identity')).body.instanceId, live.instanceId);
    } finally {
      await fs.writeFile(registration.receipt.plist, saved);
    }

    await box.ctl(['server', 'logs', '--lines', '10']);
    await box.ctl(['server', 'stop']);
    await box.ctl(['server', 'stop']);
    await box.ctl(['server', 'restart', '--wait']);

    const after = (await box.api('/api/system/runtime-identity')).body;

    assert.notEqual(after.instanceId, live.instanceId);
    assert.equal(after.productVersion, versions!.current);
    runtime.launchdProbe = live.kind === 'service' ? 'real-service' : 'manual-only';
    passed.push('MAC-VERIFY-LAUNCHER');
  });

  await t.test('MAC-VERIFY-EXIT', async (testCase) => {
    for (const action of ['close', 'app-quit'] as const) {
      const box = await platformFixture(testCase, 'local');

      await box.install(input.candidate);
      await box.ctl(['server', 'start', '--wait']);

      const before = (await box.api('/api/system/runtime-identity')).body;
      const endpoint = await box.openWindow();
      const owner = await box.windowOwner();
      const log = path.join(box.homeRoot, 'window.log');
      const control = path.join(box.dataHome, 'factory/control/launch-processes');
      const saved = control + '.test-hold';
      const preference = await evaluateWindow(endpoint, `fetch('/__shell/exit-preference', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: '{"skipConfirmation":true}',
      }).then(r => r.status)`);

      assert.equal(preference, 200);

      /**
       * Обычный оконный close и событие системного приложения сходятся через
       * main/renderer bridge. Для второго входа используется AppKit без SIGTERM.
       */
      async function requestClose() {
        if (action === 'app-quit') {
          await requestAppQuit(owner);

          return;
        }

        const status = await evaluateWindow(endpoint, `fetch('/__shell/window', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: '{"action":"close"}',
        }).then(r => r.status)`);

        assert.equal(status, 200);
      }

      const logsBefore = (await fs.stat(log)).size;

      await fs.rename(control, saved);

      try {
        await requestClose();
        await awaitAcceptance(async () => (await fs.readFile(log, 'utf8')).slice(logsBefore)
          .includes('release_activity_unknown') || null, 'mac_candidate_close_unknown_missing', 30_000);

        assert.equal(await updateProcessAlive(owner), true);
        assert.equal((await box.api('/api/system/runtime-identity')).body.instanceId, before.instanceId);
      } finally {
        await fs.rename(saved, control);
      }

      await requestClose();
      assert.equal(await box.waitForWindowExit(), 0);

      const after = (await box.api('/api/system/runtime-identity')).body;

      assert.equal(after.instanceId, before.instanceId);
      assert.equal(after.pid, before.pid);
    }

    runtime.externalServerSurvivesClose = true;
    passed.push('MAC-VERIFY-EXIT');
  });

  await t.test('MAC-VERIFY-ROLLBACK-SERVER', async (testCase) => {
    const box = await platformFixture(testCase, 'server');

    await box.install(input.previous);
    await box.ctl(['server', 'start', '--wait']);

    const { body: data } = await box.api('/api/chat/store/ensure', { purpose: 'companion' });

    assert.ok(data.chat?.id);
    await box.ctl(['server', 'stop']);
    await box.install(input.candidate);
    assert.equal((await box.state('update/job.json')).stage, 'ready');
    await box.ctl(['server', 'resume-update', '--restart', '--json']);
    assert.equal((await box.state('update/job.json')).stage, 'applied_not_started');
    assert.equal(JSON.parse((await box.ctl(['server', 'status', '--json'])).stdout).running, false);
    await box.ctl(['server', 'resume-update', '--rollback', '--json']);
    assert.equal((await box.state('update/job.json')).stage, 'rolled_back');
    await box.ctl(['server', 'start', '--wait']);
    assert.equal((await box.api('/api/system/runtime-identity')).body.productVersion, versions!.previous);
    assert.equal((await box.api('/api/chat/store/chat/' + data.chat.id)).status, 200);
    passed.push('MAC-VERIFY-ROLLBACK-SERVER');
  });

  await t.test('MAC-VERIFY-UPDATE-LOCAL', async (testCase) => {
    const box = await platformFixture(testCase, 'local');

    await box.install(input.previous);
    await box.ctl(['server', 'start', '--wait']);

    const endpoint = await box.openWindow();
    const { body: data } = await box.api('/api/chat/store/ensure', { purpose: 'companion' });

    assert.ok(data.chat?.id);
    await box.install(input.candidate);
    assert.equal((await box.state('update/job.json')).stage, 'ready');
    assert.equal((await box.api('/api/system/runtime-identity')).body.productVersion, versions!.previous);

    await applyFromWindow(endpoint);
    await awaitAcceptance(async () => (await box.state('update/job.json')).stage === 'completed' || null,
      'mac_candidate_apply_timeout', 260_000);

    assert.equal((await box.state('update/desktop-boot.json')).version, versions!.current);
    assert.equal((await box.api('/api/system/runtime-identity')).body.productVersion, versions!.current);
    assert.equal((await box.api('/api/chat/store/chat/' + data.chat.id)).status, 200);
    runtime.localUpdate = true;
  });

  for (const id of ['MAC-VERIFY-ROLLBACK-PAIR', 'MAC-VERIFY-RECOVERY-PAIR'] as const) {
    await t.test(id, async (testCase) => {
      const box = await platformFixture(testCase, 'local');

      await box.install(input.previous);
      await box.ctl(['server', 'start', '--wait']);

      const endpoint = await box.openWindow();
      const { body: data } = await box.api('/api/chat/store/ensure', { purpose: 'companion' });
      const previous = await box.state('current.json');
      const serverA = (await box.api('/api/system/runtime-identity')).body;

      assert.ok(data.chat?.id);
      await box.install(input.candidate);

      const staged = await box.state('update/job.json');
      const proof = path.join(box.root, 'update/desktop-boot.json');
      const ownerRecord = path.join(box.root, 'update/desktop-launch-process.json');
      const hiddenOwner = path.join(box.homeRoot, 'temporarily-unknown-desktop.json');
      let desktopB: DesktopOwner | undefined;
      let proofBlocked = false;
      let ownerHidden = false;

      assert.equal(staged.stage, 'ready');

      try {
        await fs.mkdir(proof, { mode: 0o700 });
        proofBlocked = true;
        await applyFromWindow(endpoint);
        await awaitAcceptance(async () => {
          const current = await box.state('current.json');

          return current.desktop === staged.target.desktop && current.server === staged.target.server || null;
        }, 'mac_candidate_pair_switch_missing', 180_000);
        desktopB = await waitForUpdatedDesktop(box, staged.target.desktop);
        assert.equal((await fs.lstat(proof)).isDirectory(), true);
        await awaitAcceptance(async () => {
          const identity = (await box.api('/api/system/runtime-identity')).body;
          const sameInstallation = identity.installationId === serverA.installationId;

          return identity.productVersion === versions!.current && sameInstallation || null;
        }, 'mac_candidate_pair_target_api_missing', 30_000);

        if (id === 'MAC-VERIFY-RECOVERY-PAIR') {
          await fs.rename(ownerRecord, hiddenOwner);
          ownerHidden = true;
          await awaitAcceptance(async () => {
            const { stage } = await box.state('update/job.json');

            return stage === 'manual_recovery_required' || null;
          }, 'mac_candidate_pair_manual_recovery_missing', 170_000);
          await waitForApplyWorkerExit(box);
          assert.equal((await box.state('update/job.json')).error.code, 'release_desktop_boot_proof_missing');
          assert.equal(await updateProcessAlive(desktopB), true);
          await assert.rejects(box.ctl(['server', 'resume-update', '--rollback', '--json']));
          await waitForApplyWorkerExit(box);
          assert.equal((await box.state('update/rollback-result.json')).state, 'failed');
          assert.equal((await box.state('update/job.json')).stage, 'manual_recovery_required');
          assert.equal(await updateProcessAlive(desktopB), true);
          assert.equal((await box.state('current.json')).desktop, staged.target.desktop);
          assert.equal((await box.state('current.json')).server, staged.target.server);
          await fs.rename(hiddenOwner, ownerRecord);
          ownerHidden = false;
          await closeFixtureDesktop(desktopB);
          await fs.rmdir(proof);
          proofBlocked = false;
          await box.ctl(['server', 'resume-update', '--rollback', '--json']);
        } else {
          const owner = desktopB;

          await awaitAcceptance(async () => !await updateProcessAlive(owner) || null,
            'mac_candidate_pair_failed_window_exit_missing', 170_000);
          await fs.rmdir(proof);
          proofBlocked = false;
          await awaitAcceptance(async () => {
            const { stage } = await box.state('update/job.json');

            return stage === 'rolled_back' || null;
          }, 'mac_candidate_pair_rollback_missing', 170_000);
          assert.equal((await box.state('update/job.json')).error.code, 'release_desktop_boot_proof_missing');
        }

        assert.equal((await box.state('update/job.json')).stage, 'rolled_back');
        assert.deepEqual(await box.state('current.json'), previous);

        const desktop = await box.state('update/desktop-boot.json');
        const server = (await box.api('/api/system/runtime-identity')).body;

        assert.equal(desktop.version, versions!.previous);
        assert.equal(await updateProcessAlive(desktop.process), true);
        assert.equal(server.productVersion, versions!.previous);
        assert.equal(server.installationId, serverA.installationId);
        assert.equal((await box.api('/api/chat/store/chat/' + data.chat.id)).status, 200);
        passed.push(id);
      } finally {
        if (ownerHidden) {
          await fs.rename(hiddenOwner, ownerRecord);
        }

        if (desktopB) {
          await closeFixtureDesktop(desktopB);
        }

        if (proofBlocked) {
          await fs.rmdir(proof);
        }
      }
    });
  }

  await t.test('MAC-VERIFY-UPDATE-SERVER-LIVE', async (testCase) => {
    const box = await platformFixture(testCase, 'server');

    await box.install(input.previous);
    await box.ctl(['server', 'start', '--wait']);

    const before = (await box.api('/api/system/runtime-identity')).body;
    const { body: data } = await box.api('/api/chat/store/ensure', { purpose: 'companion' });

    assert.ok(data.chat?.id);
    assert.equal(before.productVersion, versions!.previous);
    await box.install(input.candidate);
    assert.equal((await box.state('update/job.json')).stage, 'ready');
    assert.equal((await box.api('/api/system/runtime-identity')).body.instanceId, before.instanceId);
    await box.ctl(['server', 'resume-update', '--restart', '--json']);
    assert.equal((await box.state('update/job.json')).stage, 'completed');

    const after = (await box.api('/api/system/runtime-identity')).body;

    assert.equal(after.productVersion, versions!.current);
    assert.notEqual(after.instanceId, before.instanceId);
    assert.equal(after.installationId, before.installationId);
    assert.equal((await box.api('/api/chat/store/chat/' + data.chat.id)).status, 200);
    runtime.serverUpdate = true;
  });

  await t.test('macOS · потеря квитанции после Stop сохраняет явный откат', async (testCase) => {
    const box = await platformFixture(testCase, 'server');

    await box.install(input.previous);
    await box.ctl(['server', 'start', '--wait']);

    const pointer = await box.state('current.json');
    const before = (await box.api('/api/system/runtime-identity')).body;

    await box.install(input.candidate);

    const staged = await box.state('update/job.json');
    const blockedProof = path.join(box.root, 'update/server-drain.json');

    await fs.mkdir(blockedProof, { mode: 0o700 });

    try {
      await assert.rejects(box.ctl(['server', 'resume-update', '--restart', '--json']),
        (error) => /release_server_drain_proof_missing/u.test(errorText(error)));
      await waitForApplyWorkerExit(box);

      const failed = await box.state('update/job.json');

      assert.equal(failed.id, staged.id);
      assert.equal(failed.stage, 'manual_recovery_required');
      assert.equal(failed.error.code, 'release_server_drain_proof_missing');
      assert.ok(failed.intent.nonce);
      assert.deepEqual(await box.state('current.json'), pointer);
      assert.equal(JSON.parse((await box.ctl(['server', 'status', '--json'])).stdout).running, false);
    } finally {
      await fs.rmdir(blockedProof);
    }

    await box.ctl(['server', 'resume-update', '--rollback', '--json']);

    const restored = (await box.api('/api/system/runtime-identity')).body;

    assert.equal((await box.state('update/job.json')).stage, 'rolled_back');
    assert.deepEqual(await box.state('current.json'), pointer);
    assert.equal(restored.productVersion, before.productVersion);
    assert.notEqual(restored.instanceId, before.instanceId);
  });

  await t.test('macOS · блокировка мутаций между confirm и Stop', async (testCase) => {
    const box = await platformFixture(testCase, 'server');

    await box.install(input.previous);

    const pointer = await box.state('current.json');
    const binary = path.join(box.root, pointer.server, 'bin/grigdesk-server');
    const { runtimeRoot, packageId } = await prepareRuntime(box, binary);
    const directory = await fs.mkdtemp(path.join(box.homeRoot, 'drain-confirm-'));
    const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');
    const gate = await seedRuntimePinGate(fixture);

    await configureDecisionApi(box, fixture);
    await box.ctl(['server', 'start', '--wait']);
    await box.install(input.candidate);
    assert.equal((await box.state('update/job.json')).stage, 'ready');

    await verifyFactoryConfirmAdmission(box, fixture, gate);
    assert.equal((await box.api('/api/system/runtime-identity')).body.productVersion, versions!.current);
    drainChecks.add('closed-admission');
  });

  await t.test('macOS · progress и result используют один capability FD из комплекта', async (testCase) => {
    const box = await platformFixture(testCase, 'server');

    await box.install(input.candidate);

    const pointer = await box.state('current.json');
    const binary = path.join(box.root, pointer.server, 'bin/grigdesk-server');
    const { runtimeRoot, packageId } = await prepareRuntime(box, binary);
    const directory = await fs.mkdtemp(path.join(box.homeRoot, 'engine-status-'));
    const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');

    await seedRuntimePinGate(fixture);
    await verifyPackagedEngineStatusChannel(fixture);
    engineChecks.add('status');
  });

  await t.test('macOS · проверка внешней CLI и её reader lease', async (testCase) => {
    const box = await platformFixture(testCase, 'server');

    await box.install(input.candidate);

    const pointer = await box.state('current.json');
    const binary = path.join(box.root, pointer.server, 'bin/grigdesk-server');
    const { runtimeRoot, packageId } = await prepareRuntime(box, binary);
    const directory = await fs.mkdtemp(path.join(box.homeRoot, 'engine-cli-'));
    const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');

    await verifyPackagedEngineExternalLease(fixture);
    engineChecks.add('external-lease');
  });

  await t.test('macOS · usage из удержанных FD и конфликт подменённого имени', async (testCase) => {
    const box = await platformFixture(testCase, 'server');

    await box.install(input.candidate);

    const pointer = await box.state('current.json');
    const binary = path.join(box.root, pointer.server, 'bin/grigdesk-server');
    const { runtimeRoot, packageId } = await prepareRuntime(box, binary);
    const directory = await fs.mkdtemp(path.join(box.homeRoot, 'engine-usage-'));
    const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');

    await verifyPackagedEngineUsage(fixture);
    engineChecks.add('usage');
  });

  await t.test('macOS · launch через HTTP и восстановление после повторного Stop', async (testCase) => {
    const box = await platformFixture(testCase, 'server');

    await box.install(input.previous);

    const pointer = await box.state('current.json');
    const binary = path.join(box.root, pointer.server, 'bin/grigdesk-server');
    const { runtimeRoot, packageId } = await prepareRuntime(box, binary);
    const directory = await fs.mkdtemp(path.join(box.homeRoot, 'engine-http-'));
    const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');

    await seedRuntimePinGate(fixture);
    await configureDecisionApi(box, fixture);
    await verifyPackagedHttpEngineStop(box, fixture);
    engineChecks.add('http-runtime');

    const before = (await box.api('/api/system/runtime-identity')).body;

    await box.install(input.candidate);
    assert.equal((await box.state('update/job.json')).stage, 'ready');
    assert.equal((await box.api('/api/system/runtime-identity')).body.instanceId, before.instanceId);
    await box.ctl(['server', 'resume-update', '--restart', '--json']);
    assert.equal((await box.state('update/job.json')).stage, 'completed');
    assert.equal((await box.api('/api/system/runtime-identity')).body.productVersion, versions!.current);
    drainChecks.add('permit-retry-and-acquire');
  });

  if (engineChecks.size === 4) {
    passed.push('MAC-VERIFY-ENGINE');
  }

  await t.test('macOS · fsync до permit и видимость живого bootstrap после рестарта', async (testCase) => {
    const box = await platformFixture(testCase, 'server');

    await box.install(input.candidate);

    const pointer = await box.state('current.json');
    const binary = path.join(box.root, pointer.server, 'bin/grigdesk-server');
    const { runtimeRoot, packageId } = await prepareRuntime(box, binary);
    const directory = await fs.mkdtemp(path.join(box.homeRoot, 'drain-launch-'));
    const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');

    await seedRuntimePinGate(fixture);
    await configureDecisionApi(box, fixture);
    await box.ctl(['server', 'start', '--wait']);
    await verifyFactoryLaunchRecovery(box, fixture, binary);
    drainChecks.add('bootstrap-and-aborted-apply');
  });

  await t.test('macOS · принятый apply арбитра удерживает допуск до записи исхода', async (testCase) => {
    const box = await platformFixture(testCase, 'server');

    await box.install(input.previous);

    const pointer = await box.state('current.json');
    const binary = path.join(box.root, pointer.server, 'bin/grigdesk-server');
    const { runtimeRoot, packageId } = await prepareRuntime(box, binary);
    const directory = await fs.mkdtemp(path.join(box.homeRoot, 'drain-arbiter-'));
    const fixture = await macosRuntimePinFixture(directory, runtimeRoot, packageId, 'gate');

    await seedRuntimePinGate(fixture, 'human');
    await configureDecisionApi(box, fixture);
    await box.ctl(['server', 'start', '--wait']);
    await box.install(input.candidate);
    assert.equal((await box.state('update/job.json')).stage, 'ready');

    await verifyArbiterDrainAdmission(box, fixture);
    assert.equal((await box.api('/api/system/runtime-identity')).body.productVersion, versions!.current);
    drainChecks.add('accepted-apply-and-idempotency');
  });

  if (drainChecks.size === 4) {
    passed.push('MAC-VERIFY-DRAIN');
  }

  await t.test('MAC-VERIFY-UPDATE-REMOTE-TLS', async (testCase) => {
    const remote = await platformFixture(testCase, 'remote');
    const server = await platformFixture(testCase, 'server');
    const address = '127.0.0.1:' + await freeAcceptancePort();

    await fs.appendFile(path.join(server.dataHome, '.env'),
      `GRIGDESK_CLIENT_LISTEN=${address}\nGRIGDESK_CLIENT_ADDRESS=${address}\n`);
    await server.install(input.previous);
    await server.ctl(['server', 'start', '--wait']);

    const beforeServer = (await server.api('/api/system/runtime-identity')).body;
    const pair = await server.ctl(['device', 'add', 'Mac fixture', '--json']);
    const invitation = JSON.parse(pair.stdout).text as string;
    const pinned = decodePairing(invitation);

    await remote.install(input.previous);

    const endpoint = await remote.openWindow();
    const profilePath = path.join(remote.profile, 'settings.json');

    await evaluateWindow(endpoint, `(() => {
      void fetch('/__shell/profiles', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({pairing: ${JSON.stringify(invitation)}}),
      });
      return true;
    })()`);

    const selected = await awaitAcceptance(async () => {
      const settings = JSON.parse(await fs.readFile(profilePath, 'utf8'));
      const active = settings.profiles.find((profile: { id: string }) => profile.id === settings.selected);

      return active?.fp === pinned.fp ? active : null;
    }, 'mac_candidate_remote_pairing_missing');
    const before = JSON.parse((await server.ctl(['device', 'list', '--json'])).stdout).devices;

    assert.equal(before.length, 1);
    await remote.install(input.candidate);
    assert.equal((await remote.state('update/job.json')).stage, 'ready');
    assert.equal((await remote.state('current.json')).desktop.split('/')[1], versions!.previous);

    const paired = await remote.windowEndpoint();

    await evaluateWindow(paired, `(() => {
      void fetch('/__shell/updates/apply', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: '{"confirmed":true}',
      });
      return true;
    })()`);
    await awaitAcceptance(async () => (await remote.state('update/job.json')).stage === 'completed' || null,
      'mac_candidate_remote_apply_timeout', 260_000);

    const updateEndedAt = Date.now();
    const settings = JSON.parse(await fs.readFile(profilePath, 'utf8'));
    const pointer = await remote.state('current.json');

    assert.equal((await remote.state('update/desktop-boot.json')).version, versions!.current);
    assert.equal(pointer.server, null);
    assert.equal(settings.selected, selected.id);
    assert.equal(settings.profiles.find((profile: { id: string }) => profile.id === selected.id)?.fp,
      pinned.fp);
    assert.equal((await server.api('/api/system/runtime-identity')).body.instanceId, beforeServer.instanceId);
    await awaitAcceptance(async () => {
      const { devices } = JSON.parse((await server.ctl(['device', 'list', '--json'])).stdout);

      return devices.length === 1 && devices[0].id === before[0].id
        && devices[0].lastSeenAt >= updateEndedAt || null;
    }, 'mac_candidate_updated_mtls_device_not_seen', 100_000);
    runtime.remoteUpdate = true;
  });

  if (runtime.localUpdate === true && runtime.serverUpdate === true && runtime.remoteUpdate === true) {
    passed.push('MAC-VERIFY-UPDATE');
  }

  await t.test('MAC-VERIFY-MISSING', async (testCase) => {
    const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gd-missing-'));

    testCase.after(() => fs.rm(directory, { recursive: true, force: true }));

    for (const name of await assertCandidateFiles(input.candidate, 'darwin-arm64', 'input')) {
      if (name !== 'local-build.json') {
        await fs.copyFile(path.join(input.candidate, name), path.join(directory, name));
      }
    }

    await assert.rejects(assertCandidateFiles(directory, 'darwin-arm64', 'input'),
      /candidate_marker_missing/u);
    await fs.symlink(path.join(input.candidate, 'local-build.json'),
      path.join(directory, 'local-build.json'));
    await assert.rejects(assertCandidateFiles(directory, 'darwin-arm64', 'input'),
      /candidate_file_type_invalid:local-build.json/u);
    passed.push('MAC-VERIFY-MISSING');
  });

  await t.test('macOS · dist check использует приватные инструменты UUID', async (testCase) => {
    const directory = await fs.mkdtemp('/private/tmp/gd-check-fixture-');
    const runs = path.join(directory, 'runs');
    const temporary = path.join(directory, 'scratch');
    const tmpAlias = path.join(directory, 'tmp-alias');

    testCase.after(async () => {
      const retained = await fs.readdir(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }

        return [];
      });

      if (retained.length > 0) {
        process.stderr.write(`Сохранена нативная фикстура ${directory}\n`);
      } else {
        await removePrivateTree(directory);
      }
    });

    const manifestDigest = input.trust.expectedManifestDigest!;
    const { runId } = await createRunRecord(runs, {
      realArtifactsRoot: input.candidate,
      sourceCommit: input.trust.expectedCommit,
      sourceDigest: '0'.repeat(64),
      recipeDigest: '1'.repeat(64),
      manifestDigest,
    }, {
      publicKeyPem: input.trust.publicKeyPem,
      privateKeyPem: 'fixture verifies the signed candidate without a signing key',
    });
    const tools = path.join(runs, runId, 'verification-tools');
    const processIdentity = path.join(tools, 'process-identity');
    const setsid = path.join(tools, 'setsid');

    await fs.mkdir(temporary, { mode: 0o700 });
    await fs.symlink(temporary, tmpAlias);
    await fs.mkdir(tools, { mode: 0o700 });
    await fs.copyFile(process.env.GRIGDESK_BUILD_PROCESS_HELPER!, processIdentity);
    await fs.copyFile(process.env.GRIGDESK_TEST_SETSID_BIN!, setsid);
    await Promise.all([fs.chmod(processIdentity, 0o500), fs.chmod(setsid, 0o500)]);

    const inventory = await Promise.all((await fs.readdir(input.candidate)).map(async (name) => {
      const file = path.join(input.candidate, name);

      return {
        name,
        size: (await fs.lstat(file)).size,
        sha256: await sha256File(file),
      };
    }));

    await completeRunRecord(runs, runId, 'verified', inventory, {
      verificationTools: {
        processIdentity: await sha256File(processIdentity),
        setsid: await sha256File(setsid),
      },
    });

    const record = await fs.readFile(path.join(runs, runId, 'run.json'));
    const checkout = path.resolve(import.meta.dirname, '../..');
    const settings = {
      cwd: checkout,
      env: {
        ...process.env,
        TMPDIR: tmpAlias,
        GRIGDESK_DIST_RUN_DIR: runs,
      },
      timeout: 720_000,
    };
    const argv = ['tools/distribution.mts', 'check', '--local-run', runId];
    const result = await execute(process.execPath, argv, settings);

    assert.equal(JSON.parse(result.stdout).verified, true);
    assert.deepEqual(await fs.readdir(temporary), []);
    assert.equal((await readRunRecord(runs, runId)).stage, 'verified');

    const fixture = {
      directory,
      temporary,
      argv,
      settings,
    };

    for (const [signal, tamper] of [['SIGINT', false], ['SIGTERM', false], ['SIGTERM', true]] as const) {
      await interruptVerifiedMacService(fixture, signal, tamper);
      assert.deepEqual(await fs.readdir(temporary), []);
      assert.deepEqual(await fs.readFile(path.join(runs, runId, 'run.json')), record);
    }

    await fs.chmod(setsid, 0o700);
    await fs.appendFile(setsid, 'damaged fixture');
    await fs.chmod(setsid, 0o500);
    await assert.rejects(execute(process.execPath, argv, settings),
      (error) => /darwin_build_tool_invalid/u.test(errorText(error)));
    assert.deepEqual(await fs.readdir(temporary), []);
    assert.deepEqual(await fs.readFile(path.join(runs, runId, 'run.json')), record);
  });

  await writePlatformAcceptance({
    installModes: ['local', 'remote', 'server'],
    passed,
    runtime,
  });
});
