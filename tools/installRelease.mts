import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ReleaseEnvelope } from '../shared/runtime/installedUpdateContracts.ts';
import { decodeReleaseChannelIndex } from '../shared/runtime/installedUpdateContracts.ts';
import { verifyReleaseEnvelope } from '../shared/node/releaseTrust.ts';
import { extractReleaseArtifact } from '../shared/node/releaseArchive.ts';
import { copyInstallFile, lstatOrNull } from '../shared/node/binaryInstall.ts';
import { writeInstallationJson, assertInstallationPath, readInstallation }
  from '../shared/node/installedLayout.ts';
import { readInstalledPointer } from '../shared/node/installedLayout.ts';
import type { InstallationReceipt, InstalledPointer } from '../shared/node/installedLayout.ts';
import { shellQuote } from '../shared/lib/shellQuote.ts';
import { desktopRuntimePath, parseRuntimeDescriptor } from '../shared/desktop/desktopRuntime.ts';
import { InstalledUpdateManager } from '../shared/node/installedUpdate.ts';
import { probeInstalledComponent } from '../shared/node/installedUpdateService.ts';
import { readUpdateProcess } from '../shared/node/updateProcessOwner.ts';
import { verifyInstalledGeneration } from '../shared/node/installedUpdateApply.ts';
import { syncDirectory } from '../shared/node/files.ts';

const execute = promisify(execFile);

export interface InstallReleaseInput {
  root: string;
  mode: InstallationReceipt['mode'];
  dataHome: string;
  userData: string;
  binDirectory: string;
  applicationsDirectory: string;
  envelope: ReleaseEnvelope;
  maintenance: string;
  unitDirectory?: string;
  archive(component: 'desktop' | 'server'): Promise<string>;
}

/**
 * Первая установка раскладывает только готовые подписанные компоненты вне папки данных.
 * Коллизия с существующей установкой или ярлыком прекращает работу до записи launchers.
 */
export async function installRelease(input: InstallReleaseInput): Promise<InstallationReceipt> {
  const payload = input.envelope.payload;

  decodeReleaseChannelIndex({
    format: 2,
    channel: payload.channel,
    publishedAt: payload.publishedAt,
    latest: input.envelope,
  });

  const digest = verifyReleaseEnvelope(input.envelope);

  if (!['local', 'remote', 'server'].includes(input.mode)
    || [input.root, input.dataHome, input.userData, input.binDirectory, input.applicationsDirectory,
      ...input.unitDirectory ? [input.unitDirectory] : []]
      .some((name) => !path.isAbsolute(name) || path.resolve(name) !== name || name.includes('\n'))
    || [input.dataHome, input.userData].some((name) => name === input.root
      || name.startsWith(input.root + path.sep))) {
    throw new Error('installation_input_invalid');
  }

  const launchers = [path.join(input.binDirectory, 'grigdesk-ctl'),
    ...input.mode !== 'server' ? [path.join(input.binDirectory, 'grigdesk')] : []];
  const shortcut = path.join(input.applicationsDirectory, 'grigdesk.desktop');

  /**
   * Обрыв первой установки (крах между mkdir и публикацией current.json) оставляет
   * каталог без валидного receipt: повторный запуск завершает установку с нуля,
   * а не падает вечным ENOENT. Данные и профиль живут вне root и не затрагиваются.
   */
  const publishedInstallation = await lstatOrNull(path.join(input.root, 'installation.json'));
  const publishedPointer = await lstatOrNull(path.join(input.root, 'current.json'));

  if (await lstatOrNull(input.root) && (!publishedInstallation || !publishedPointer)) {
    await fs.rm(input.root, { recursive: true, force: true });
  }

  if (await lstatOrNull(input.root)) {
    const receipt = await readInstallation(input.root);

    if (receipt.mode !== input.mode || receipt.dataHome !== input.dataHome
      || receipt.userData !== input.userData || receipt.channel !== payload.channel) {
      throw new Error('installation_collision_use_update_status');
    }

    const current = await readInstalledPointer(receipt);
    const components = input.mode === 'local' ? ['desktop', 'server'] as const
      : [input.mode === 'remote' ? 'desktop' as const : 'server' as const];

    if (components.every((component) => current[component]?.split('/')[1] === payload.version)) {
      for (const component of components) {
        const installed = await verifyInstalledGeneration(receipt, current[component]!, component);

        if (verifyReleaseEnvelope(installed) !== digest) {
          throw new Error('release_generation_identity_invalid');
        }
      }

      return receipt;
    }

    const manager = new InstalledUpdateManager({
      root: receipt.root,
      channel: { latest: async () => input.envelope },
      probe: probeInstalledComponent,
    });
    const job = await manager.createJob({
      requestId: `installer-${digest}`,
      manifestDigest: digest,
      scope: input.mode === 'local' ? 'pair' : input.mode === 'remote' ? 'desktop' : 'server',
    });

    if (['queued', 'failed'].includes(job.stage)) {
      const directory = path.join(input.root, 'update', job.id);

      await fs.mkdir(directory, { recursive: true, mode: 0o700 });

      for (const component of job.scope === 'pair' ? ['desktop', 'server'] as const : [job.scope]) {
        const archive = path.join(directory, `${component}.tar.gz`);

        if (!await lstatOrNull(archive)) {
          await copyInstallFile(await input.archive(component), archive);
        }
      }

      await manager.prepare(job.id);
    }

    return receipt;
  }

  const unitFile = input.mode === 'remote' || !input.unitDirectory ? null
    : path.join(input.unitDirectory, 'grigdesk-server.service');
  const descriptor = input.mode === 'local'
    ? desktopRuntimePath({ env: process.env, home: process.env.HOME! }) : null;
  const previousRuntime = descriptor ? await lstatOrNull(descriptor) : null;
  let previousRuntimeText: string | null = null;

  if (unitFile && /[\s"%\\]/u.test(input.root + input.dataHome)) {
    throw new Error('installation_service_path_invalid');
  }

  if (previousRuntime && descriptor) {
    previousRuntimeText = await fs.readFile(descriptor, 'utf8');

    const parsed = parseRuntimeDescriptor(previousRuntimeText);

    if (!previousRuntime.isFile() || previousRuntime.isSymbolicLink()
      || previousRuntime.uid !== process.getuid!()
      || previousRuntime.mode & 0o077 || !parsed || parsed.version === 5
      || 'home' in parsed && parsed.home !== input.dataHome) {
      throw new Error('installation_runtime_collision');
    }

    try {
      const owner = JSON.parse(await fs.readFile(path.join(input.dataHome, 'state/server.lock'), 'utf8')) as {
        pid: number; starttime: string;
      };
      const processIdentity = await readUpdateProcess(owner.pid);

      if (processIdentity.starttime === owner.starttime) {
        throw new Error('installation_close_previous_server');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  if ((await Promise.all(launchers.map(lstatOrNull))).some(Boolean)
    || input.mode !== 'server' && await lstatOrNull(shortcut) || unitFile && await lstatOrNull(unitFile)) {
    throw new Error('installation_collision_use_update_status');
  }

  await fs.mkdir(path.dirname(input.root), { recursive: true, mode: 0o700 });
  await fs.mkdir(input.root, { mode: 0o700 });

  const receipt: InstallationReceipt = {
    format: 1,
    installationId: randomUUID(),
    uid: process.getuid!(),
    root: input.root,
    mode: input.mode,
    channel: payload.channel,
    dataHome: input.dataHome,
    userData: input.userData,
  };
  const components: ('desktop' | 'server')[] = input.mode === 'local'
    ? ['desktop', 'server'] : [input.mode === 'remote' ? 'desktop' : 'server'];
  const generation = path.join(input.root, 'generations', payload.version);

  await assertInstallationPath(input.root);
  await fs.mkdir(generation, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(input.root, 'update'), { mode: 0o700 });
  await fs.mkdir(path.join(input.root, 'bin'), { mode: 0o700 });

  for (const component of components) {
    await extractReleaseArtifact(await input.archive(component),
      path.join(generation, component), payload.artifacts[component]);
  }

  await copyInstallFile(input.maintenance, path.join(input.root, 'update/maintenance'));
  await writeInstallationJson(input.root, 'installation.json', receipt);
  await writeInstallationJson(input.root, `generations/${payload.version}/release.json`, input.envelope);

  const pointer: InstalledPointer = {
    format: 1,
    installationId: receipt.installationId,
    desktop: components.includes('desktop') ? `generations/${payload.version}/desktop` : null,
    server: components.includes('server') ? `generations/${payload.version}/server` : null,
  };

  await writeInstallationJson(input.root, 'current.json', pointer);

  const helper = shellQuote(path.join(input.root, 'update/maintenance'));
  const makeLauncher = async (file: string, action: string) => {
    await fs.writeFile(file, `#!/bin/sh\nexec ${helper} ${action} "$@"\n`, {
      flag: 'wx',
      mode: 0o755,
    });
  };

  await fs.mkdir(input.binDirectory, { recursive: true, mode: 0o755 });
  await makeLauncher(path.join(input.binDirectory, 'grigdesk-ctl'), 'ctl');

  if (components.includes('server')) {
    await makeLauncher(path.join(input.root, 'bin/grigdesk-server'), 'launch server');
  }

  if (components.includes('desktop')) {
    await makeLauncher(path.join(input.binDirectory, 'grigdesk'), 'launch desktop');
    await fs.mkdir(input.applicationsDirectory, { recursive: true, mode: 0o755 });

    const executable = path.join(input.binDirectory, 'grigdesk');

    if (/["`$\\%]/u.test(executable)) {
      throw new Error('installation_shortcut_path_invalid');
    }

    await fs.writeFile(shortcut, '[Desktop Entry]\nType=Application\nName=GrigDesk\n'
      + `Exec="${executable}"\nTerminal=false\nCategories=Network;\n`, { flag: 'wx', mode: 0o644 });
  }

  if (descriptor) {
    await fs.mkdir(path.dirname(descriptor), { recursive: true, mode: 0o700 });

    if (previousRuntimeText !== null) {
      const actual = await fs.lstat(descriptor);

      if (actual.dev !== previousRuntime!.dev || actual.ino !== previousRuntime!.ino
        || await fs.readFile(descriptor, 'utf8') !== previousRuntimeText) {
        throw new Error('installation_runtime_changed');
      }

      await writeInstallationJson(input.root, 'update/previous-desktop-runtime.json',
        JSON.parse(previousRuntimeText));
    }

    const temporary = `${descriptor}.${receipt.installationId}`;

    await fs.writeFile(temporary, JSON.stringify({
      version: 5,
      kind: 'installed',
      root: input.root,
      installationId: receipt.installationId,
      home: input.dataHome,
      cliPaths: [path.join(input.root, pointer.server!, 'bin')],
    }) + '\n', { flag: 'wx', mode: 0o600 });

    const handle = await fs.open(temporary, 'r');

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (!previousRuntime && await lstatOrNull(descriptor)) {
      throw new Error('installation_runtime_collision');
    }

    await fs.rename(temporary, descriptor);
    await syncDirectory(path.dirname(descriptor));
  }

  if (unitFile) {
    await fs.mkdir(path.dirname(unitFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(unitFile, `# GrigDesk installationId=${receipt.installationId}\n`
      + '[Unit]\nDescription=GrigDesk\nAfter=network.target\nStartLimitIntervalSec=0\n'
      + '[Service]\nType=simple\n'
      + `ExecStart=${input.root}/bin/grigdesk-server\nWorkingDirectory=${input.root}\n`
      + `Environment=GRIGDESK_HOME=${receipt.dataHome}\nEnvironmentFile=-${receipt.dataHome}/.env\n`
      + 'Restart=always\nRestartPreventExitStatus=78\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=60\n'
      + '[Install]\nWantedBy=default.target\n', { flag: 'wx', mode: 0o600 });

    try {
      await execute('systemctl', ['--user', 'daemon-reload'], { timeout: 5000 });
    } catch {
      // Без user-systemd канонический ctl использует manual lease, ничего не enable/start.
    }
  }

  return receipt;
}
