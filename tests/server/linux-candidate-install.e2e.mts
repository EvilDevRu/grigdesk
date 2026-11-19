import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { syncDirectory } from '../../shared/node/files.ts';
import { updateProcessAlive } from '../../shared/node/installedServer.ts';
import { readUpdateProcess } from '../../shared/node/updateProcessOwner.ts';
import {
  acceptanceInputs, awaitAcceptance, evaluateWindow, platformFixture, verifyAcceptanceModes,
  verifyAcceptanceVersions, writePlatformAcceptance,
} from '../helpers/platformReleaseAcceptance.mts';

/**
 * Берёт exact helper из списка потомков собственного installer shell.
 * Другой PID даже с таким же именем в этот сценарий не попадает.
 */
async function findInstallerHelper(box: Awaited<ReturnType<typeof platformFixture>>,
  shell: number, source: string) {
  const children = await fs.readFile(`/proc/${shell}/task/${shell}/children`, 'utf8');
  const prefix = path.join(box.env.TMPDIR!, 'grigdesk-install.');

  for (const pid of children.trim().split(/\s+/u).map(Number).filter((value) => value > 0)) {
    const owner = await readUpdateProcess(pid).catch(() => null);

    if (!owner?.executable.startsWith(prefix) || path.basename(owner.executable) !== 'helper') {
      continue;
    }

    const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');

    if (args.includes('install-online') && args[args.indexOf('--root') + 1] === box.root
      && args[args.indexOf('--source-dir') + 1] === source && await updateProcessAlive(owner)) {
      return owner;
    }
  }

  throw new Error('candidate_install_helper_missing');
}

/**
 * Следит за публикацией job.json настоящим maintenance. Фиксирует выбранную
 * стадию и обрывает только собственный helper до смены указателя.
 */
async function interruptPreparation(box: Awaited<ReturnType<typeof platformFixture>>, source: string,
  phase: 'downloading' | 'preparing') {
  const update = path.join(box.root, 'update');
  const cancelled = new AbortController();
  const events = fs.watch(update, {
    signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(150_000)]),
  });
  const installer = box.install(source);
  const settled = installer.then(() => 0, (error: { code?: number }) => error.code ?? 1);
  let jobId: string | null = null;

  void settled.then(() => cancelled.abort());

  for await (const event of events) {
    if (event.eventType !== 'rename' || event.filename !== 'job.json') {
      continue;
    }

    const job = await box.state('update/job.json');

    if (job.stage !== phase) {
      continue;
    }

    assert.ok(installer.child.pid);

    const helper = await findInstallerHelper(box, installer.child.pid, source);

    process.kill(helper.pid, 'SIGSTOP');

    try {
      await syncDirectory(update);
      assert.equal((await box.state('update/job.json')).stage, phase);
      jobId = job.id;
    } finally {
      if (await updateProcessAlive(helper)) {
        process.kill(helper.pid, 'SIGKILL');
      }
    }

    break;
  }

  assert.ok(jobId);
  assert.notEqual(await settled, 0);

  return jobId;
}

test('Проверка готового Linux кандидата', { timeout: 3_000_000 }, async (t) => {
  const input = acceptanceInputs('linux');
  const versions = await verifyAcceptanceVersions(input);
  const passed: string[] = [];

  await t.test('LINUX-VERIFY-MODES', async (testCase) => {
    await verifyAcceptanceModes(testCase, input);
    passed.push('LINUX-VERIFY-MODES');
  });

  await t.test('LINUX-VERIFY-OFFLINE-UPDATE', async (testCase) => {
    const box = await platformFixture(testCase, 'local');

    await box.install(input.previous);
    await box.ctl(['server', 'start', '--wait']);

    const start = await box.api('/api/system/runtime-identity');

    assert.equal(start.status, 200);
    assert.equal(start.body.productVersion, versions.previous);

    const { body: original } = await box.api('/api/chat/store/ensure', { purpose: 'companion' });

    assert.ok(original.chat?.id);

    const previous = await box.state('current.json');
    const first = await interruptPreparation(box, input.candidate, 'downloading');

    assert.equal((await box.state('update/job.json')).stage, 'downloading');
    await assert.rejects(fs.lstat(path.join(box.root, 'update', first, 'desktop.tar.gz')), {
      code: 'ENOENT',
    });
    assert.deepEqual(await box.state('current.json'), previous);

    const incomplete = path.join(box.homeRoot, 'Incomplete B');

    await fs.mkdir(incomplete);

    for (const file of ['grigdesk-install', 'grigdesk-maintenance.gz', 'dev.json']) {
      await fs.copyFile(path.join(input.candidate, file), path.join(incomplete, file));
    }

    await fs.writeFile(path.join(incomplete, 'desktop.tar.gz'), Buffer.from([0x1f, 0x8b]));
    await assert.rejects(box.install(incomplete), (error) =>
      /install_online_source_invalid/u.test(String((error as { stderr?: string }).stderr)));

    const interrupted = await box.state('update/job.json');

    assert.equal(interrupted.id, first);
    assert.equal(interrupted.stage, 'failed');
    await assert.rejects(box.ctl(['server', 'resume-update', '--json']),
      (error) => /candidate_source_required/u.test(String((error as { stderr?: string }).stderr)));
    await assert.rejects(box.ctl(['server', 'update-channel', 'release', '--json']),
      (error) => /candidate_channel_fixed/u.test(String((error as { stderr?: string }).stderr)));

    assert.equal(await interruptPreparation(box, input.candidate, 'preparing'), interrupted.id);
    assert.equal((await box.state('update/job.json')).stage, 'preparing');
    assert.deepEqual(await box.state('current.json'), previous);
    await assert.rejects(box.ctl(['server', 'resume-update', '--json']),
      (error) => /candidate_source_required/u.test(String((error as { stderr?: string }).stderr)));

    const endpoint = await box.openWindow();

    await box.install(input.candidate);

    const ready = await box.state('update/job.json');

    assert.equal(ready.id, interrupted.id);
    assert.equal(ready.stage, 'ready');
    assert.equal((await box.api('/api/system/runtime-identity')).body.productVersion, versions.previous);
    assert.equal((await box.api('/api/chat/store/chat/' + original.chat.id)).status, 200);

    await awaitAcceptance(async () => (await evaluateWindow(endpoint,
      "fetch('/__shell/state').then(r => r.json()).then(s => s.applicationUpdate?.job?.stage)") === 'ready')
      || null, 'linux_candidate_ready_missing');
    await evaluateWindow(endpoint, `(() => {
      void fetch('/__shell/updates/apply', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: '{"confirmed":true}',
      });
      return true;
    })()`);

    await awaitAcceptance(async () => {
      const result = await box.state('update/job.json');

      if (result.stage === 'manual_recovery_required' || result.stage === 'rolled_back') {
        throw new Error(result.error?.code ?? result.stage);
      }

      return result.stage === 'completed' ? result : null;
    }, 'linux_candidate_apply_timeout', 260_000);

    const proof = await box.state('update/desktop-boot.json');

    assert.equal(proof.version, versions.current);
    assert.equal((await box.api('/api/system/runtime-identity')).body.productVersion, versions.current);
    assert.equal((await box.api('/api/chat/store/chat/' + original.chat.id)).status, 200);
    passed.push('LINUX-VERIFY-OFFLINE-UPDATE');
  });

  await writePlatformAcceptance({
    installModes: ['local', 'remote', 'server'],
    passed,
    runtime: { versions },
  });
});
