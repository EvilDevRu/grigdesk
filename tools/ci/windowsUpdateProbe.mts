import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { sha256File } from '../../shared/node/hash.ts';
import {
  buildWindowsNative, productionWindowsKey, verifyFirstLaunch, verifyUninstall,
  verifyWindowsPackage, windowsStableInputs,
} from './windowsNative.mts';

const execute = promisify(execFile);

interface ProbeStep {
  step: string;
  version?: string;
  ok: boolean;
}

/**
 * Читает версию установленного поколения из подписанной описи в каталоге программы.
 * Описание проверяется тем же ключом выпуска, поэтому подмена версии не проходит.
 */
async function installedVersion(destination: string): Promise<string> {
  const raw = await fs.readFile(path.join(destination, 'release.json'), 'utf8');
  const envelope = JSON.parse(raw) as { payload: string };
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as { version: string };

  return payload.version;
}

/**
 * Запускает помощник обновления или отката из комплекта B. Ключ помощника закреплён
 * при сборке и совпадает с ключом установки, поэтому проверка описи проходит.
 */
async function maintenance(helper: string, args: string[]): Promise<void> {
  await execute(helper, args, {
    timeout: 300_000,
    windowsHide: true,
  });
}

/**
 * Проба собирает предыдущее и текущее поколения и проверяет полный цикл обновления:
 * установка A, переход на B, отказ на повреждённом пакете, откат к A и запуск после него.
 * Пользовательские данные лежат отдельно от каталога программы и сохраняются на каждом шаге.
 */
async function main(): Promise<void> {
  const [target, planFile, output, ...extra] = process.argv.slice(2);

  if (!output || extra.length) {
    throw new Error('windows_update_probe_arguments_invalid');
  }

  const input = await windowsStableInputs(target, planFile);
  const key = productionWindowsKey();
  const local = process.env.LOCALAPPDATA;

  if (!local) {
    throw new Error('windows_update_probe_localappdata_missing');
  }

  const work = await fs.mkdtemp(path.join(local, 'GrigDesk Update Probe '));
  const previousSource = path.join(work, 'package-previous');
  const currentSource = path.join(work, 'package-current');
  const destination = path.join(work, 'GrigDesk Installed');
  const steps: ProbeStep[] = [];

  try {
    const previousPlan = {
      ...input.plan,
      current: input.plan.previous,
    };

    await buildWindowsNative(input.target, previousPlan, previousSource, key);
    await buildWindowsNative(input.target, input.plan, currentSource, key);
    await verifyWindowsPackage(previousSource, input.target, previousPlan, key);
    await verifyWindowsPackage(currentSource, input.target, input.plan, key);

    const helper = path.join(currentSource, 'grigdesk-maintenance.exe');
    const dataHome = path.join(work, 'Server Data');
    const keep = path.join(dataHome, 'probe-keep.txt');
    const bootstrap = path.join(previousSource, 'grigdesk-install.ps1');

    await execute('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', bootstrap, '-Yes', '-InstallDir', destination,
    ], {
      timeout: 300_000,
      windowsHide: true,
    });
    await verifyFirstLaunch(destination, work, input.target);
    steps.push({
      step: 'install-previous',
      version: await installedVersion(destination),
      ok: true,
    });

    await fs.mkdir(dataHome, { recursive: true });
    await fs.writeFile(keep, 'grigdesk-update-probe\n', { flag: 'wx' });
    await maintenance(helper, ['update', currentSource, destination]);

    const afterUpdate = await installedVersion(destination);

    if (afterUpdate !== input.plan.current.version) {
      throw new Error('windows_update_probe_version_not_current');
    }

    await verifyFirstLaunch(destination, work, input.target);
    steps.push({
      step: 'update-current',
      version: afterUpdate,
      ok: true,
    });

    const serverZip = path.join(currentSource, 'server.zip');
    const original = await fs.readFile(serverZip);

    await fs.writeFile(serverZip, Buffer.concat([original, Buffer.from('tamper')]));

    let corruptRejected = false;

    try {
      await maintenance(helper, ['update', currentSource, destination]);
    } catch {
      corruptRejected = true;
    }

    if (!corruptRejected || await installedVersion(destination) !== input.plan.current.version) {
      throw new Error('windows_update_probe_corrupt_not_rejected');
    }

    steps.push({
      step: 'corrupt-rejected',
      version: await installedVersion(destination),
      ok: true,
    });
    await fs.writeFile(serverZip, original);
    await maintenance(helper, ['rollback', destination]);

    const afterRollback = await installedVersion(destination);

    if (afterRollback !== input.plan.previous.version) {
      throw new Error('windows_update_probe_rollback_version_invalid');
    }

    await verifyFirstLaunch(destination, work, input.target);

    if (await fs.readFile(keep, 'utf8') !== 'grigdesk-update-probe\n') {
      throw new Error('windows_update_probe_data_lost');
    }

    steps.push({
      step: 'rollback-previous',
      version: afterRollback,
      ok: true,
    });
    await verifyUninstall(destination, work);
    steps.push({
      step: 'uninstall-data-kept',
      ok: true,
    });

    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'windows-update-probe.json'), JSON.stringify({
      format: 1,
      platform: input.target,
      commit: input.plan.current.commit,
      previousVersion: input.plan.previous.version,
      currentVersion: input.plan.current.version,
      previousPackageSha256: await sha256File(path.join(previousSource, 'server.zip')),
      currentPackageSha256: await sha256File(path.join(currentSource, 'server.zip')),
      steps,
    }, null, 2) + '\n', { flag: 'wx' });
  } finally {
    await fs.rm(work, {
      force: true,
      recursive: true,
      maxRetries: 3,
      retryDelay: 500,
    });
  }
}

await main();