import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { removePrivateTree } from '../../shared/node/files.ts';
import { updateProcessAlive, type InstalledServerOwner } from '../../shared/node/installedServer.ts';
import { readInstallation } from '../../shared/node/installedLayout.ts';
import { darwinInstalledService, stopDarwinInstalledService }
  from '../../shared/node/launchdInstalledService.ts';
import type { DarwinVerificationBinding } from '../../shared/node/darwinVerificationStartup.ts';
import { awaitAcceptance, execute } from './platformReleaseAcceptance.mts';
import type { platformFixture } from './platformReleaseAcceptance.mts';

type Signal = 'SIGINT' | 'SIGTERM';

interface CheckFixture {
  directory: string;
  temporary: string;
  argv: string[];
  settings: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
  };
}

interface CommandOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface StartupWitness {
  root: string;
  ctl: string;
  port: number;
  env: NodeJS.ProcessEnv;
  live: InstalledServerOwner;
}

/**
 * Ставит барьер в отдельном Node процесса dist check после живого API.
 * Настоящие Start, проверка владельца и cleanup исполняются без подмен.
 */
async function holdBeforeStop(hook: string, witness: string): Promise<void> {
  const moduleUrl = new URL('../../tools/verifyInstallation.mts', import.meta.url).href;
  const barrier = `
      if (live && outcome.probe?.status === 'fulfilled') {
        await fs.writeFile(${JSON.stringify(witness)}, JSON.stringify({ root, ctl, port, env, live }),
          { flag: 'wx', mode: 0o600 });
        const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
        if (!signal.aborted) {
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        }
      }
  `;
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({
      load(url, context, next) {
        const loaded = next(url, context);
        if (url !== ${JSON.stringify(moduleUrl)}) return loaded;
        const source = String(loaded.source);
        const mark = "      await execute(maintenance, ['verify-stop-server',";
        if (source.split(mark).length !== 2) throw new Error('candidate_check_boundary_missing');
        return { ...loaded, source: source.replace(mark, () => ${JSON.stringify(barrier)} + mark) };
      }
    });
  `;

  await fs.writeFile(hook, script, { flag: 'wx', mode: 0o600 });
}

/**
 * Ожидает закрытый порт с точным кодом отказа. Timeout сам по себе
 * не означает, что сервер прекратил слушать.
 */
async function refused(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) })
    .then(async (response) => {
      await response.body?.cancel();

      return false;
    }, (error: { cause?: { code?: string } }) => error.cause?.code === 'ECONNREFUSED');
}

/**
 * Воспроизводит точную границу после bootstrap до kickstart в своей установке.
 * Ошибочная привязка оставляет запись launchd, штатная очистка снимает её без PID.
 */
export async function verifyInactiveLaunchAgent(box: Awaited<ReturnType<typeof platformFixture>>) {
  const receipt = await readInstallation(box.root);
  const before = await darwinInstalledService(receipt);

  if (before.state === 'no-domain') {
    return 'no-gui-domain';
  }

  assert.equal(before.state, 'unloaded');

  const { registration } = before;
  const port = Number(new URL(box.origin).port);
  const binding: DarwinVerificationBinding = {
    installationId: receipt.installationId,
    port,
    registration: registration.receipt,
  };
  const wrong = {
    ...binding,
    registration: { ...binding.registration, sha256: '0'.repeat(64) },
  };
  const maintenance = path.join(box.root, 'update/maintenance');
  const lease = path.join(box.root, 'update/server-process.json');
  const log = path.join(box.root, 'update/server.log');
  const previousLog = await fs.readFile(log);

  await assert.rejects(fs.lstat(lease), { code: 'ENOENT' });
  assert.equal(await refused(port), true);
  await execute('/bin/launchctl', ['bootstrap', registration.domain, registration.receipt.plist],
    { env: box.env, timeout: 15_000 });

  try {
    const loaded = await darwinInstalledService(receipt);

    assert.equal(loaded.state, 'loaded');
    assert.equal(loaded.pid, null);
    assert.equal(loaded.startScheduled, false);
    await assert.rejects(execute(maintenance, ['verify-stop-server', JSON.stringify(wrong), 'null'],
      { env: box.env, timeout: 20_000 }), /dist_verification_service_scope_invalid/u);
    assert.deepEqual(await darwinInstalledService(receipt), loaded);
    await execute(maintenance, ['verify-stop-server', JSON.stringify(binding), 'null'],
      { env: box.env, timeout: 65_000 });
    assert.equal((await darwinInstalledService(receipt)).state, 'unloaded');
    assert.equal(await refused(port), true);
    await assert.rejects(fs.lstat(lease), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(log), previousLog);

    return 'inactive-bootout';
  } finally {
    const remaining = await darwinInstalledService(receipt);

    if (remaining.state === 'loaded') {
      await stopDarwinInstalledService(receipt, null, registration.receipt);
    }
  }
}

/**
 * Прерывает только CLI проверки после зарегистрированного запуска. Фикстура
 * отдельно восстанавливает заведомо свою повреждённую квитанцию.
 */
export async function interruptVerifiedMacService(input: CheckFixture, signal: Signal, tamper = false) {
  const label = signal.toLowerCase() + (tamper ? '-unknown' : '');
  const hook = path.join(input.directory, label + '.mjs');
  const evidence = path.join(input.directory, label + '.json');
  const listener = createServer((_request, response) => response.end('independent-check'));

  await holdBeforeStop(hook, evidence);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');

  const address = listener.address();

  assert.ok(address && typeof address === 'object');

  const command = execute(process.execPath, ['--import', hook, ...input.argv], input.settings);
  const settled = command.then(({ stdout, stderr }) => ({
    code: 0,
    stdout,
    stderr,
  }), (error: CommandOutcome) => error);
  let witness: StartupWitness | null = null;
  let savedLease = false;

  try {
    witness = await awaitAcceptance(async () => JSON.parse(await fs.readFile(evidence, 'utf8')),
      'candidate_check_live_barrier_missing', 300_000);
    assert.ok(witness?.live.process && witness.live.launcher);

    const installRoot = path.dirname(path.dirname(witness.root));
    const lease = path.join(witness.root, 'update/server-process.json');
    const originals = [witness.live.process, witness.live.launcher];

    assert.equal(path.dirname(installRoot), input.temporary);
    assert.match(path.basename(installRoot), /^dist-check-/u);
    assert.ok((await Promise.all(originals.map(updateProcessAlive))).every(Boolean));

    if (tamper) {
      await fs.rename(lease, lease + '.fixture');
      savedLease = true;
      await fs.writeFile(lease, '{"format":99}\n', { flag: 'wx', mode: 0o600 });
    }

    assert.ok(command.child.kill(signal));

    const result = await settled;

    assert.equal(result.code, signal === 'SIGINT' ? 130 : 143, result.stderr);
    assert.doesNotMatch(result.stdout, /"verified":true/u);

    const response = await fetch(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(3000) });

    assert.equal(await response.text(), 'independent-check');

    if (tamper) {
      assert.ok(result.stderr.includes(installRoot));
      await fs.access(path.join(witness.root, 'installation.json'));
      await fs.access(path.join(witness.root, 'update/server.log'));
      assert.ok((await Promise.all(originals.map(updateProcessAlive))).every(Boolean));
    } else {
      await assert.rejects(fs.lstat(installRoot), { code: 'ENOENT' });
      assert.equal(await refused(witness.port), true);
      assert.ok((await Promise.all(originals.map(updateProcessAlive))).every((alive) => !alive));
    }
  } finally {
    if (command.child.exitCode === null && command.child.signalCode === null) {
      command.child.kill(signal);
    }

    await settled;
    listener.close();

    if (witness && savedLease) {
      const lease = path.join(witness.root, 'update/server-process.json');
      const installRoot = path.dirname(path.dirname(witness.root));

      await fs.rename(lease + '.fixture', lease);
      assert.equal(path.dirname(installRoot), input.temporary);
      await execute(witness.ctl, ['server', 'stop'], { env: witness.env, timeout: 75_000 });
      assert.equal(await refused(witness.port), true);
      await removePrivateTree(installRoot);
    }
  }
}
