import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, type ExecFileOptions } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { promisify } from 'node:util';

import { verifyDistributionArtifacts, type DistributionTrust }
  from './releaseArtifactVerification.mts';
import { copyInstallFile } from '../shared/node/binaryInstall.ts';
import { verifyReleaseInstaller } from './releaseArtifactVerification.mts';
import { sha256File } from '../shared/node/hash.ts';
import { installedExecutableSuffix } from '../shared/node/bundleLayout.ts';
import { dataPath } from '../shared/runtime/dataHome.ts';
import { runDarwinBuildProcess } from '../cli/darwinBuildProcesses.ts';
import { configureDarwinBuildProcessHelper } from '../shared/node/processIdentity.ts';
import { readInstallation } from '../shared/node/installedLayout.ts';
import { readDarwinServiceRegistration } from '../shared/node/launchdInstalledService.ts';
import type { InstalledServerOwner } from '../shared/node/installedServer.ts';
import type { DarwinVerificationBinding } from '../shared/node/darwinVerificationStartup.ts';
import { readDarwinBuildSetsid } from './darwinBuildTools.mts';

const execute = promisify(execFile);

export type VerificationScopeState = 'idle' | 'busy' | 'clean' | 'unknown';

export interface VerifyInstallationOptions {
  trust: DistributionTrust;
  modes?: ('local' | 'remote' | 'server')[];
  installRoot: string;
  xvfb?: boolean;
  signal?: AbortSignal;
  nativeTools?: NodeJS.ProcessEnv;
  onScopeState?(state: VerificationScopeState): void;
}

export interface InstallationModeProof {
  completed: true;
  guiAcceptance: 'not-performed';
  commit: string;
  channel: 'release' | 'dev';
  archiveSha256: { desktop: string; server: string };
  mode: 'local' | 'remote' | 'server';
  installationId: string;
  root: string;
  version: string;
  digest: string;
  scriptSha256: string;
  helperSha256: string;
  components: { desktop: boolean; server: boolean };
  probes: {
    server: boolean;
    desktop: 'xvfb' | 'direct' | 'not-installed';
    launchd?: 'real-service' | 'manual-only';
  };
}

type Command = (file: string, argv: string[], options: ExecFileOptions,
  finishStartup?: (report: string | null) => Promise<void>) => Promise<{
  stdout: string;
  stderr: string;
}>;

interface NativeServerScope {
  root: string;
  ctl: string;
  maintenance: string;
  env: NodeJS.ProcessEnv;
  dataHome: string;
  port: number;
  owner: string;
  version: string;
  binary: string;
  packageId: string;
}

/**
 * Runs a finite native command in its own observed session.
 * An unknown process or incomplete capture leaves the verifier scope intact.
 */
async function darwinProbeCommand(options: VerifyInstallationOptions, fallback: Command): Promise<Command> {
  if (!options.nativeTools) {
    return fallback;
  }

  const nativeTools = options.nativeTools;

  await configureDarwinBuildProcessHelper(nativeTools);

  /**
   * Only confirmed terminal output is handed to the caller for parsing.
   * Start and Stop of a persistent service use the separate service operation.
   */
  return async (file, argv, commandOptions, finishStartup) => {
    const setsid = await readDarwinBuildSetsid(nativeTools);

    options.signal?.throwIfAborted();

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    options.onScopeState?.('busy');

    const result = await runDarwinBuildProcess({
      file,
      args: argv,
      cwd: options.installRoot,
      env: commandOptions.env ?? {},
      setsid,
      output: 'pipe',
      timeoutMs: commandOptions.timeout ?? 5000,
      signal: options.signal,
      finishStartup: finishStartup && ((reported) =>
        finishStartup(reported ? Buffer.concat(stdout).toString() : null)),
      capture: async (child, signal) => {
        const limit = commandOptions.maxBuffer ?? 1024 * 1024;

        await Promise.all([
          readProbeOutput(child.stdout!, stdout, limit, signal),
          readProbeOutput(child.stderr!, stderr, limit, signal),
        ]);
      },
    });

    if (!result.cleanupConfirmed) {
      options.onScopeState?.('unknown');

      throw new Error('dist_verification_cleanup_unconfirmed', { cause: result.error });
    }

    options.onScopeState?.('clean');
    options.signal?.throwIfAborted();

    if (result.code !== 0 || result.reason !== null) {
      throw new Error(`dist_verification_command_failed:${result.reason ?? result.code}`, {
        cause: result.error ?? Buffer.concat(stderr).toString(),
      });
    }

    return {
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    };
  };
}

/**
 * Enforces the same output bound as the execFile verifier.
 * Cancellation is checked on each chunk.
 */
async function readProbeOutput(input: AsyncIterable<Buffer>, output: Buffer[], limit: number,
  signal: AbortSignal): Promise<void> {
  let size = 0;

  for await (const chunk of input) {
    signal.throwIfAborted();
    size += chunk.length;

    if (size > limit) {
      throw new Error('dist_verification_output_limit');
    }

    output.push(chunk);
  }
}

/**
 * Читает живую identity только ожидаемой установки через её временный порт.
 * Статус и API должны показать тот же SEA worker и ту же инкарнацию.
 */
async function probeDarwinService(input: NativeServerScope, live: InstalledServerOwner,
  signal?: AbortSignal) {
  const { dataHome, port, owner, version, packageId, binary } = input;
  const origin = 'http://127.0.0.1:' + port;
  const token = (await fs.readFile(dataPath(dataHome, 'cliToken'), { encoding: 'utf8', signal })).trim();
  const deadline = AbortSignal.timeout(5000);
  const response = await fetch(origin + '/api/system/runtime-identity', {
    headers: { 'X-GrigDesk-Token': token },
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });

  assert.equal(response.status, 200);

  const identity = await response.json();

  assert.ok(live.running && live.process && live.launcher);
  assert.equal(identity.installationId, owner);
  assert.equal(identity.productVersion, version);
  assert.equal(identity.packageId, packageId);
  assert.equal(identity.binary, binary);
  assert.equal(identity.pid, live.process.pid);
  assert.equal(identity.instanceId, live.instanceId);
  assert.notEqual(live.process.pid, live.launcher.pid);
  assert.ok(live.kind === 'service' || live.kind === 'manual');

  return live.kind === 'service' ? 'real-service' as const : 'manual-only' as const;
}

/**
 * Start, живой API и проверенный Stop составляют один scope.
 * При отмене Stop использует свой срок, а census watcher проходит после него.
 */
async function verifyDarwinService(input: NativeServerScope, command: Command,
  options: VerifyInstallationOptions): Promise<'real-service' | 'manual-only'> {
  const { ctl, maintenance, env, port, owner, root } = input;
  const receipt = await readInstallation(root);
  const registration = await readDarwinServiceRegistration(receipt);
  const binding: DarwinVerificationBinding = {
    installationId: owner,
    port,
    registration: registration.receipt,
  };
  const statusArgs = ['server', 'status', '--json'];
  const settings = { env, timeout: 15_000 };

  assert.equal(receipt.installationId, owner);
  assert.equal(receipt.dataHome, input.dataHome);

  try {
    const before = JSON.parse((await command(ctl, statusArgs, settings)).stdout);

    assert.equal(before.running, false);
    assert.equal(before.kind, 'stopped');
  } catch (error) {
    if (!options.signal?.aborted) {
      options.onScopeState?.('unknown');
    }

    throw error;
  }

  const outcome: { probe?: PromiseSettledResult<'real-service' | 'manual-only'> } = {};

  await command(ctl, ['server', 'start', '--wait', '--json'], { env, timeout: 150_000 }, async (report) => {
    try {
      const live = report === null ? null : JSON.parse(report) as InstalledServerOwner;

      if (report !== null) {
        assert.ok(live?.running && live.process && live.launcher && live.instanceId);
        assert.ok(live.kind === 'service' || live.kind === 'manual');
      }

      if (live) {
        [outcome.probe] = await Promise.allSettled([probeDarwinService(input, live, options.signal)]);
      }

      await execute(maintenance, ['verify-stop-server', JSON.stringify(binding), JSON.stringify(live)],
        { env, timeout: 95_000 });

      const refused = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      }).then(async (response) => {
        await response.body?.cancel();

        return false;
      }, (error: unknown) =>
        (error as { cause?: { code?: string } } | null)?.cause?.code === 'ECONNREFUSED');

      assert.equal(refused, true);
    } catch (error) {
      options.onScopeState?.('unknown');

      throw new Error('dist_verification_service_cleanup_unconfirmed', { cause: error });
    }
  });

  const { probe } = outcome;

  if (probe?.status === 'rejected') {
    throw probe.reason;
  }

  assert.ok(probe);

  return probe.value;
}

/**
 * Выделяет нештатные loopback порты для одного физического D.
 * Порты зарезервированы одновременно, запись передаётся через штатный файл настроек.
 */
async function writeDarwinProbePorts(dataHome: string): Promise<number> {
  const listeners = [createServer(), createServer()];

  try {
    const ports: number[] = [];

    for (const listener of listeners) {
      listener.listen(0, '127.0.0.1');
      await once(listener, 'listening');

      const address = listener.address();

      assert.ok(address && typeof address === 'object');
      assert.ok(address.port !== 8140 && address.port !== 8144);
      ports.push(address.port);
    }

    await fs.mkdir(dataHome, { mode: 0o700 });
    await fs.writeFile(path.join(dataHome, '.env'),
      `GRIGDESK_PORT=${ports[0]}\nGRIGDESK_MOBILE_PORT=${ports[1]}\n`, { flag: 'wx', mode: 0o600 });

    return ports[0]!;
  } finally {
    await Promise.all(listeners.filter((listener) => listener.listening).map((listener) =>
      new Promise<void>((resolve) => listener.close(() => resolve()))));
  }
}

/**
 * Приёмка готового кандидата: каждый режим ставится настоящим скриптом в свой
 * изолированный профиль (приложение C), затем проверяются receipt/current, uid,
 * принадлежность путей профилю и реальные пробы сервера и окна. GUI-приёмка
 * остаётся ручной и здесь не заявляется.
 */
export async function verifyInstallation(directory: string, expectedCommit: string,
  options: VerifyInstallationOptions): Promise<InstallationModeProof[]> {
  assert.equal(expectedCommit, options.trust.expectedCommit);
  options.onScopeState?.('idle');

  const verified = await verifyDistributionArtifacts(directory, {
    ...options.trust, requireHostPlatform: true,
  }, options.signal);

  options.signal?.throwIfAborted();
  await fs.mkdir(options.installRoot, { recursive: true, mode: 0o700 });

  const script = path.join(options.installRoot, 'verified-install-script');

  await copyInstallFile(path.join(directory, 'grigdesk-install'), script);
  await verifyReleaseInstaller(script, verified.envelope,
    await fs.readFile(path.join(directory, 'grigdesk-install.sha256'), 'utf8'),
    await fs.readFile(path.join(directory, 'grigdesk-install.sig'), 'utf8'),
    options.trust.publicKeyPem);

  const modes = options.modes ?? ['local', 'remote', 'server'];
  const darwin = verified.envelope.payload.platform.os === 'darwin';
  const proofs: InstallationModeProof[] = [];
  const executeCommand: Command = async (file, argv, ports, finishStartup) => {
    options.signal?.throwIfAborted();

    let stdout: string | null = null;

    try {
      const result = await execute(file, argv, {
        ...ports,
        encoding: 'utf8',
        signal: options.signal,
      });

      stdout = result.stdout;

      return result;
    } finally {
      await finishStartup?.(stdout);
    }
  };
  const command = darwin ? await darwinProbeCommand(options, executeCommand) : executeCommand;

  for (const mode of modes) {
    options.signal?.throwIfAborted();

    const profile = path.join(options.installRoot, `acceptance-${mode}`);

    await fs.mkdir(profile, { mode: 0o700 });

    const home = path.join(profile, 'home');
    const root = path.join(profile, darwin ? 'Program= GrigDesk' : 'program');
    const dataHome = path.join(profile, 'data');
    const userData = path.join(profile, 'user');
    const binDir = path.join(profile, darwin ? 'User CLI' : 'bin');
    const appsDir = path.join(profile, 'apps');
    const unitDir = path.join(profile, darwin ? 'Launch Agents' : 'units');

    for (const dir of [home, path.join(home, '.cache'), path.join(home, '.config'),
      path.join(home, '.local/share'), path.join(profile, 'runtime'),
      path.join(profile, 'tmp')]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    }

    const env = {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HOME: home,
      GRIGDESK_HOME: dataHome,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_RUNTIME_DIR: path.join(profile, 'runtime'),
      TMPDIR: path.join(profile, 'tmp'),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(profile, 'runtime/bus')}`,
      ...!darwin && process.env.APPIMAGE_EXTRACT_AND_RUN === '1' ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {},
    };

    const probePort = darwin ? await writeDarwinProbePorts(dataHome) : null;

    await command('sh', [script, '--yes', '--mode', mode, '--root', root,
      '--data-home', dataHome, '--user-data', userData, '--bin-dir', binDir,
      '--applications-dir', appsDir, '--unit-dir', unitDir, '--source-dir', directory],
    {
      env,
      timeout: 20 * 60_000,
      maxBuffer: 16 * 1024 * 1024
    });

    const receipt = JSON.parse(await fs.readFile(path.join(root, 'installation.json'),
      'utf8'));
    const pointer = JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'));

    assert.equal(receipt.uid, process.getuid!());
    assert.equal(receipt.mode, mode);
    assert.equal(receipt.root, root);
    assert.equal(receipt.dataHome, dataHome);
    assert.equal(receipt.installationId, pointer.installationId);
    assert.equal(await sha256File(path.join(root, 'update/maintenance')),
      verified.bootstrap.helperSha256);

    const physicalProfile = await fs.realpath(profile);
    const physicalRoot = await fs.realpath(root);

    assert.ok(physicalRoot.startsWith(physicalProfile + path.sep));
    assert.ok(!dataHome.startsWith(root + path.sep));

    const components = { desktop: Boolean(pointer.desktop), server: Boolean(pointer.server) };

    assert.equal(components.desktop, mode !== 'server');
    assert.equal(components.server, mode !== 'remote');

    if (darwin) {
      const plist = path.join(unitDir, `com.grigdesk.server.${receipt.installationId}.plist`);
      const descriptor = path.join(env.XDG_DATA_HOME, 'grigdesk/desktop/runtime.json');
      const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

      assert.equal(await exists(plist), components.server);
      assert.equal(await exists(path.join(root, 'service.json')), components.server);
      assert.equal(await exists(descriptor), mode === 'local');

      if (components.server) {
        await command('/usr/bin/plutil', ['-lint', plist], {});

        const { stdout } = await command('/usr/bin/plutil',
          ['-extract', 'RunAtLoad', 'raw', '-o', '-', plist], {});

        assert.equal(stdout.trim(), 'false');
      }
    }

    const probes: InstallationModeProof['probes'] = { server: false,
      desktop: pointer.desktop ? 'direct' : 'not-installed' };

    if (pointer.server) {
      const serverBinary = path.join(root, pointer.server, 'bin/grigdesk-server');
      const metadata = await command(serverBinary, ['--runtime-info', '--json'],
        {
          env,
          timeout: 120_000,
          maxBuffer: 1024 * 1024
        });

      assert.equal(JSON.parse(metadata.stdout).packageId,
        verified.envelope.payload.artifacts.server.packageId);
      assert.equal(JSON.parse(metadata.stdout).version, verified.envelope.payload.version);

      const probe = await command(serverBinary, ['--verify', '--json'],
        {
          env,
          timeout: 120_000,
          maxBuffer: 1024 * 1024
        });

      assert.equal(probe.stderr, '');
      assert.equal(JSON.parse(probe.stdout).verified, true);
      probes.server = true;

      if (probePort !== null) {
        probes.launchd = await verifyDarwinService({
          root,
          ctl: path.join(binDir, 'grigdesk-ctl'),
          maintenance: path.join(root, 'update/maintenance'),
          env,
          dataHome,
          port: probePort,
          owner: receipt.installationId,
          version: verified.envelope.payload.version,
          packageId: verified.envelope.payload.artifacts.server.packageId!,
          binary: serverBinary,
        }, command, options);
      }
    }

    if (pointer.desktop) {
      const platform = verified.envelope.payload.platform.os;
      const desktopBinary = path.join(root, pointer.desktop, installedExecutableSuffix('desktop', platform));
      const xvfbAvailable = platform === 'linux' && await command('bash', ['-c', 'command -v xvfb-run'], {})
        .then(() => true, () => false);
      const useXvfb = options.xvfb !== false && xvfbAvailable;
      const argv = useXvfb
        ? ['xvfb-run', '-a', desktopBinary, '--grigdesk-release-probe']
        : [desktopBinary, '--grigdesk-release-probe'];
      const probe = await command(argv[0]!, argv.slice(1),
        {
          env,
          timeout: 180_000,
          maxBuffer: 1024 * 1024
        });

      assert.equal(JSON.parse(probe.stdout).releaseId, verified.envelope.payload.releaseId);
      assert.equal(JSON.parse(probe.stdout).version, verified.envelope.payload.version);
      probes.desktop = useXvfb ? 'xvfb' : 'direct';
    }

    proofs.push({
      completed: true,
      guiAcceptance: 'not-performed',
      commit: verified.envelope.payload.commit,
      channel: verified.envelope.payload.channel,
      archiveSha256: {
        desktop: verified.envelope.payload.artifacts.desktop.sha256,
        server: verified.envelope.payload.artifacts.server.sha256,
      },
      mode,
      installationId: receipt.installationId,
      root,
      version: verified.envelope.payload.version,
      digest: verified.bootstrap.manifestDigest,
      scriptSha256: await sha256File(script, options.signal),
      helperSha256: verified.bootstrap.helperSha256,
      components,
      probes,
    });
  }

  options.signal?.throwIfAborted();

  return proofs;
}
