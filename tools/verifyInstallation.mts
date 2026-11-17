import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { verifyDistributionArtifacts, type DistributionTrust }
  from './releaseArtifactVerification.mts';
import { copyInstallFile } from '../shared/node/binaryInstall.ts';
import { verifyReleaseInstaller } from './releaseArtifactVerification.mts';
import { sha256File } from '../shared/node/hash.ts';

const execute = promisify(execFile);

export interface VerifyInstallationOptions {
  trust: DistributionTrust;
  modes?: ('local' | 'remote' | 'server')[];
  installRoot: string;
  xvfb?: boolean;
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
  probes: { server: boolean; desktop: 'xvfb' | 'direct' | 'not-installed' };
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

  const verified = await verifyDistributionArtifacts(directory, options.trust);

  await fs.mkdir(options.installRoot, { recursive: true, mode: 0o700 });

  const script = path.join(options.installRoot, 'verified-install-script');

  await copyInstallFile(path.join(directory, 'grigdesk-install'), script);
  await verifyReleaseInstaller(script, verified.envelope,
    await fs.readFile(path.join(directory, 'grigdesk-install.sha256'), 'utf8'),
    await fs.readFile(path.join(directory, 'grigdesk-install.sig'), 'utf8'),
    options.trust.publicKeyPem);

  const modes = options.modes ?? ['local', 'remote', 'server'];
  const proofs: InstallationModeProof[] = [];

  for (const mode of modes) {
    const profile = path.join(options.installRoot, `acceptance-${mode}`);

    await fs.mkdir(profile, { mode: 0o700 });

    const home = path.join(profile, 'home');
    const root = path.join(profile, 'program');
    const dataHome = path.join(profile, 'data');
    const userData = path.join(profile, 'user');
    const binDir = path.join(profile, 'bin');
    const appsDir = path.join(profile, 'apps');
    const unitDir = path.join(profile, 'units');

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
    };

    await execute('sh', [script, '--yes', '--mode', mode, '--root', root,
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

    const probes: InstallationModeProof['probes'] = { server: false,
      desktop: pointer.desktop ? 'direct' : 'not-installed' };

    if (pointer.server) {
      const serverBinary = path.join(root, pointer.server, 'bin/grigdesk-server');
      const metadata = await execute(serverBinary, ['--runtime-info', '--json'],
        {
          env,
          timeout: 120_000,
          maxBuffer: 1024 * 1024
        });

      assert.equal(JSON.parse(metadata.stdout).packageId,
        verified.envelope.payload.artifacts.server.packageId);
      assert.equal(JSON.parse(metadata.stdout).version, verified.envelope.payload.version);

      const probe = await execute(serverBinary, ['--verify', '--json'],
        {
          env,
          timeout: 120_000,
          maxBuffer: 1024 * 1024
        });

      assert.equal(probe.stderr, '');
      assert.equal(JSON.parse(probe.stdout).verified, true);
      probes.server = true;
    }

    if (pointer.desktop) {
      const desktopBinary = path.join(root, pointer.desktop, 'GrigDesk');
      const xvfbAvailable = await execute('bash', ['-c', 'command -v xvfb-run'])
        .then(() => true, () => false);
      const useXvfb = options.xvfb !== false && xvfbAvailable;
      const argv = useXvfb
        ? ['xvfb-run', '-a', desktopBinary, '--grigdesk-release-probe']
        : [desktopBinary, '--grigdesk-release-probe'];
      const probe = await execute(argv[0]!, argv.slice(1),
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
      scriptSha256: await sha256File(script),
      helperSha256: verified.bootstrap.helperSha256,
      components,
      probes,
    });
  }

  return proofs;
}
