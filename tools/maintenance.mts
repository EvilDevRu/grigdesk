import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isSea, getAsset } from 'node:sea';

import { assertInstallationPath, readInstallation, readInstalledPointer, writeInstallationJson }
  from '../shared/node/installedLayout.ts';
import { assertInstallationReleaseTrust, installedExecutableSuffix } from '../shared/node/bundleLayout.ts';
import { readUpdateProcess } from '../shared/node/updateProcessOwner.ts';
import { readDarwinProcessIdentity, tryDarwinInstallLease } from '../shared/node/processIdentity.ts';
import { InstalledUpdateService } from '../shared/node/installedUpdateService.ts';
import { runInstalledUpdateWorker } from '../shared/node/installedUpdateWorker.ts';
import { registerInstalledServerLaunch } from '../shared/node/installedServer.ts';
import { runInstalledCli } from '../cli/installedCli.ts';
import { dataHome } from '../shared/runtime/dataHome.ts';
import type { ReleaseEnvelope } from '../shared/runtime/installedUpdateContracts.ts';
import { runInstallOnline } from './installOnline.mts';
import { installRelease } from './installRelease.mts';
import { copyInstallerArchive, verifyInstallerArchive } from '../shared/node/installerArchiveTail.ts';
import { decodeReleaseChannelIndex } from '../shared/runtime/installedUpdateContracts.ts';
import { verifyReleaseEnvelope } from '../shared/node/releaseTrust.ts';
import { DARWIN_SERVICE_MARKER } from '../shared/node/darwinServiceRegistration.ts';
import { darwinInstalledService } from '../shared/node/launchdInstalledService.ts';
import { acceptDarwinDesktopLaunch } from '../shared/node/darwinDesktopUpdate.ts';
import { rollbackAttemptPattern } from '../shared/node/darwinRollbackAttempt.ts';
import { stopDarwinVerificationServer } from '../shared/node/darwinVerificationStartup.ts';

/**
 * В SEA хранится только небольшое подписанное описание, архивы читаются из хвоста ELF.
 * Схема и подпись проверяются до вычисления границ или создания установки.
 */
function installerRelease(): ReleaseEnvelope {
  const source = JSON.parse(getAsset('release', 'utf8')) as ReleaseEnvelope;
  const index = decodeReleaseChannelIndex({
    format: 2,
    channel: source.payload.channel,
    publishedAt: source.payload.publishedAt,
    latest: source,
  });

  if (!index.latest) {
    throw new Error('installer_release_missing');
  }

  verifyReleaseEnvelope(index.latest);

  return index.latest;
}

/**
 * Installed entry содержит собственный Node и не ищет исходники, npm или серверный payload.
 * Служебные команды принимают только известные действия и installation-bound job id.
 */
export async function runMaintenance(argv: string[]): Promise<number> {
  const [action, ...args] = argv;

  if (action === 'install-lock-fd' && !args.length && process.platform === 'darwin' && isSea()) {
    return await tryDarwinInstallLease(3) ? 0 : 75;
  }

  if (action === 'inspect-process' && args.length === 1 && /^[1-9][0-9]*$/u.test(args[0]!)
    && process.platform === 'darwin' && isSea()) {
    const result = await readDarwinProcessIdentity(Number(args[0]));

    if (result.state !== 'alive') {
      return result.state === 'dead' ? 3 : 74;
    }

    process.stdout.write(JSON.stringify(result.identity) + '\n');

    return 0;
  }

  if (action === '--runtime-info' && args.length === 1 && args[0] === '--json') {
    process.stdout.write(JSON.stringify({
      kind: 'grigdesk-maintenance',
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      sea: isSea(),
    }) + '\n');

    return 0;
  }

  if (action === 'install-online') {
    return runInstallOnline(args);
  }

  if (action === '--verify') {
    if (!isSea() || args.length !== 1 || args[0] !== '--json') {
      throw new Error('Использование: grigdesk-install --verify --json');
    }

    const envelope = installerRelease();

    for (const component of ['server', 'desktop'] as const) {
      await verifyInstallerArchive(process.execPath, envelope.payload.artifacts, component);
    }

    process.stdout.write(JSON.stringify({
      verified: true,
      version: envelope.payload.version,
      commit: envelope.payload.commit,
      archiveHashesValid: true,
    }) + '\n');

    return 0;
  }

  if (action === 'install') {
    const mode = args[0];
    const paths = new Map<string, string>();

    for (let index = 1; index < args.length; index += 2) {
      const key = args[index]!;
      const value = args[index + 1];

      const accepted = ['--root', '--data-home', '--user-data', '--bin-dir',
        '--applications-dir', '--unit-dir'];

      if (!accepted.includes(key)
        || paths.has(key) || !value || !path.isAbsolute(value)) {
        throw new Error('installation_arguments_invalid');
      }

      paths.set(key, path.resolve(value));
    }

    if (!isSea() || !['local', 'remote', 'server'].includes(mode ?? '')) {
      throw new Error('Использование: grigdesk-install install local|remote|server');
    }

    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-install-'));

    try {
      const envelope = installerRelease();

      await installRelease({
        root: paths.get('--root') ?? path.join(os.homedir(), '.local/lib/grigdesk'),
        mode: mode as 'local' | 'remote' | 'server',
        dataHome: paths.get('--data-home') ?? dataHome({ env: process.env, home: os.homedir() }),
        userData: paths.get('--user-data')
          ?? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'GrigDesk'),
        binDirectory: paths.get('--bin-dir') ?? path.join(os.homedir(), '.local/bin'),
        applicationsDirectory: paths.get('--applications-dir')
          ?? path.join(os.homedir(), '.local/share/applications'),
        unitDirectory: paths.get('--unit-dir')
          ?? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user'),
        maintenance: process.execPath,
        envelope,
        async archive(component) {
          const file = path.join(temporary, `${component}.tar.gz`);

          await copyInstallerArchive(process.execPath, envelope.payload.artifacts, component, file);

          return file;
        },
      });

      return 0;
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  const root = path.resolve(path.dirname(process.execPath), '..');
  const receipt = await readInstallation(root);

  if (process.platform === 'darwin' && action === 'rollback' && args.length === 2
    && args.every((value) => rollbackAttemptPattern.test(value))) {
    await runInstalledUpdateWorker(root, args[0]!, 'rollback', args[1]!);

    return 0;
  }

  if (['apply', 'recover', ...(process.platform === 'darwin' ? [] : ['rollback'])].includes(action ?? '')
    && args.length === 1
    && /^[a-f0-9-]{36}$/u.test(args[0]!)) {
    await runInstalledUpdateWorker(root, args[0]!, action as 'apply' | 'recover' | 'rollback');

    return 0;
  }

  if (action === 'launch-update-desktop' && process.platform === 'darwin' && args.length === 2
    && args.every((value) => rollbackAttemptPattern.test(value))) {
    await acceptDarwinDesktopLaunch(receipt, args[0]!, args[1]!);

    return runMaintenance(['launch', 'desktop']);
  }

  if (action === 'prepare' && args.length === 1 && /^[a-f0-9-]{36}$/u.test(args[0]!)) {
    assertInstallationReleaseTrust(receipt);

    if (receipt.format === 2) {
      throw new Error('candidate_source_required');
    }

    await writeInstallationJson(root, 'update/prepare-process.json', {
      jobId: args[0],
      process: await readUpdateProcess(process.pid),
    });
    await new InstalledUpdateService(root).manager().prepare(args[0]!);

    return 0;
  }

  if (action === 'launch' && ['server', 'desktop'].includes(args[0] ?? '')) {
    const component = args[0] as 'server' | 'desktop';
    const current = await readInstalledPointer(receipt);
    const selected = current[component];

    if (!selected) {
      throw new Error('installation_component_missing');
    }

    const executable = await assertInstallationPath(root,
      selected + '/' + installedExecutableSuffix(component));
    const launchAgent = process.platform === 'darwin' && component === 'server'
      && process.env[DARWIN_SERVICE_MARKER] !== undefined;
    const service = launchAgent ? await darwinInstalledService(receipt) : null;

    if (service && (service.pid !== process.pid || service.state !== 'loaded'
      || process.env[DARWIN_SERVICE_MARKER] !== service.registration.receipt.label)) {
      throw new Error('release_foreign_service');
    }

    const env = service ? { ...service.registration.env }
      : Object.fromEntries(Object.entries(process.env)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

    env.GRIGDESK_HOME = receipt.dataHome;
    env.GRIGDESK_DESKTOP_DATA_DIR = receipt.userData;
    env.GRIGDESK_ENV_FILE = path.join(receipt.dataHome, '.env');

    for (const key of ['APPIMAGE', 'APPDIR', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) {
      delete env[key];
    }

    const cgroup = process.platform === 'linux' && component === 'server'
      ? await fs.readFile('/proc/self/cgroup', 'utf8') : '';

    if (component === 'desktop'
      || !cgroup.split(/[\n/]/u).includes('grigdesk-server.service')) {
      delete env.INVOCATION_ID;
      delete env.JOURNAL_STREAM;
      delete env.NOTIFY_SOCKET;
    }

    if (component === 'server') {
      env.PATH = path.join(root, selected, 'bin') + ':' + (env.PATH ?? '/usr/bin:/bin');
      delete env.GRIGDESK_DESKTOP_CHILD;
      delete env.GRIGDESK_DESKTOP_PARENT;
      await registerInstalledServerLaunch(root, executable, service ? 'service' : 'manual');
    }

    if (!process.execve) {
      throw new Error('maintenance_runtime_incompatible');
    }

    process.execve(executable, [executable, ...args.slice(1)], env);

    throw new Error('maintenance_exec_failed');
  }

  if (action === 'ctl') {
    return runInstalledCli(root, args);
  }

  if (action === 'verify-stop-server' && process.platform === 'darwin'
    && args.length === 2 && args.every((arg) => arg.length <= 8192)) {
    await stopDarwinVerificationServer(receipt, JSON.parse(args[0]!), JSON.parse(args[1]!));

    return 0;
  }

  throw new Error('maintenance_action_invalid');
}

if (isSea() || process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  // SEA сохраняет два служебных элемента argv, как запуск обычного файла Node.
  // Команда начинается с третьего элемента в обоих вариантах запуска.
  void runMaintenance(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'maintenance_failed'}\n`);
    process.exitCode = 1;
  });
}
