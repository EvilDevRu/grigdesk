import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { shellQuote } from '../../../shared/lib/shellQuote.ts';
import { desktopRuntimePath } from '../../../shared/desktop/desktopRuntime.ts';
import { copyInstallFile, lstatOrNull } from '../../../shared/node/binaryInstall.ts';
import { installationTrustFields } from '../../../shared/node/bundleLayout.ts';
import { darwinServiceRegistration } from '../../../shared/node/darwinServiceRegistration.ts';
import { syncDirectory } from '../../../shared/node/files.ts';
import { sha256, sha256File } from '../../../shared/node/hash.ts';
import {
  assertInstallationPath, installationFileProof, publishInstallFile, readInstallPublication,
  verifyInstallPublication, writeInstallationJson,
} from '../../../shared/node/installedLayout.ts';
import type {
  InstallationFileProof, InstallationReceipt, InstalledPointer,
} from '../../../shared/node/installedLayout.ts';
import { verifyInstalledGeneration } from './installedUpdateApply.ts';
import { materializeMacDesktop } from '../../../shared/node/macosAppArchive.ts';
import { publishDarwinInstallStage } from '../../../shared/node/processIdentity.ts';
import { extractReleaseArtifact, releaseArtifactDiskBytes } from '../../../shared/node/releaseArchive.ts';
import { assertInstallParents } from './installPaths.mts';
import type { InstallReleaseInput } from './installRelease.mts';

type Component = 'desktop' | 'server';

interface InstallOutput {
  file: string;
  bytes: string;
  mode: number;
}

interface InstallIntent {
  format: 1;
  manifestDigest: string;
  receipt: InstallationReceipt;
  staging: string;
  paths: {
    bin: string;
    applications: string;
    units: string | null;
  };
  published: Record<string, InstallationFileProof>;
  internal: Record<string, InstallationFileProof>;
  maintenance: InstallationFileProof;
}

const jsonBytes = (value: unknown) => canonicalJson(value) + '\n';
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const intentFile = (root: string) => root + '.installing.json';
const proofFile = (root: string) => root + '.install-proof.json';

/**
 * У каждой регистрации свой неизменяемый launcher. Запуск серверного
 * поколения и окна после обновления выполняется через maintenance.
 */
function outputs(input: InstallReleaseInput, receipt: InstallationReceipt, pointer: InstalledPointer) {
  const helper = shellQuote(path.join(input.root, 'update/maintenance'));
  const launcher = (action: string) => '#!/bin/sh\nexec ' + helper + ' ' + action + ' "$@"\n';
  const published: InstallOutput[] = [{
    file: path.join(input.binDirectory, 'grigdesk-ctl'),
    bytes: launcher('ctl'),
    mode: 0o755,
  }];
  const internal: InstallOutput[] = [];

  if (pointer.desktop) {
    published.push({
      file: path.join(input.binDirectory, 'grigdesk'),
      bytes: launcher('launch desktop'),
      mode: 0o755,
    });
  }

  if (pointer.server) {
    if (!input.unitDirectory) {
      throw new Error('installation_service_directory_missing');
    }

    const { service, bytes } = darwinServiceRegistration(receipt, input.unitDirectory);

    published.push({
      file: service.plist,
      bytes,
      mode: 0o600,
    });
    internal.push({
      file: 'bin/grigdesk-server',
      bytes: launcher('launch server'),
      mode: 0o755,
    }, {
      file: 'service.json',
      bytes: jsonBytes(service),
      mode: 0o600,
    }, {
      file: 'update/server.log',
      bytes: '',
      mode: 0o600,
    });
  }

  if (input.mode === 'local') {
    published.push({
      file: desktopRuntimePath({ env: process.env, home: os.homedir() }),
      bytes: jsonBytes({
        version: 5,
        kind: 'installed',
        root: receipt.root,
        installationId: receipt.installationId,
        home: receipt.dataHome,
        cliPaths: [path.join(receipt.root, pointer.server!, 'bin')],
      }),
      mode: 0o600,
    });
  }

  return { published, internal };
}

/**
 * Stage и конечный root проходят одну проверку. Приватный proof
 * подтверждает closure внутренних файлов до публикации внешних имён.
 */
async function verifyStage(
  root: string, intent: InstallIntent, pointer: InstalledPointer, files: InstallOutput[],
) {
  await assertInstallationPath(root);

  const layout = [
    'bin', 'generations', 'installation.json', 'update', ...(pointer.server ? ['service.json'] : []),
  ];
  const stat = await fs.lstat(root);
  const parts = (['desktop', 'server'] as const).filter((component) => pointer[component]);
  const generation = path.posix.dirname(pointer[parts[0]!]!);
  const version = path.posix.basename(generation);
  const expectedUpdates = pointer.server ? 'maintenance,server.log' : 'maintenance';

  if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700 || await fs.realpath(root) !== root
    || (await fs.readdir(root)).sort().join(',') !== layout.sort().join(',')
    || (await fs.readdir(path.join(root, 'update'))).sort().join(',') !== expectedUpdates
    || (await fs.readdir(path.join(root, 'bin'))).join(',') !== (pointer.server ? 'grigdesk-server' : '')
    || (await fs.readdir(path.join(root, 'generations'))).join(',') !== version
    || (await fs.readdir(path.join(root, generation))).sort().join(',')
      !== [...parts, 'release.json'].sort().join(',')) {
    throw new Error('installation_incomplete_conflict');
  }

  const maintenance = await assertInstallationPath(root, 'update/maintenance');

  await verifyInstallPublication(maintenance, intent.maintenance);

  for (const entry of files) {
    const file = await assertInstallationPath(root, entry.file);

    await verifyInstallPublication(file, intent.internal[entry.file]!);
  }

  for (const component of parts) {
    await verifyInstalledGeneration({ ...intent.receipt, root }, pointer[component]!, component);
  }
}

/**
 * Очищается лишь приватный staging, закреплённый в matching intent.
 * Первый incomplete attempt без proof безопасно создаёт дерево снова.
 */
async function buildStage(
  input: InstallReleaseInput,
  intent: InstallIntent,
  pointer: InstalledPointer,
  files: InstallOutput[],
): Promise<void> {
  const { staging } = intent;
  const previous = await lstatOrNull(staging);
  const components = (['desktop', 'server'] as const).filter((component) => pointer[component]);
  const generation = path.posix.dirname(pointer[components[0]!]!);
  const space = await fs.statfs(path.dirname(staging));
  const required = components.reduce((sum, component) => (
    sum + releaseArtifactDiskBytes(input.envelope.payload.artifacts[component])
  ), intent.maintenance.size + 64 * 1024 * 1024);

  if (space.bavail * space.bsize < required) {
    throw new Error('release_disk_space_insufficient');
  }

  if (previous) {
    if (!previous.isDirectory() || previous.uid !== intent.receipt.uid
      || (previous.mode & 0o7777) !== 0o700) {
      throw new Error('installation_incomplete_conflict');
    }

    await assertInstallationPath(staging);
    await fs.rm(staging, { recursive: true });
  }

  const sources = new Map<Component, string>();

  for (const component of components) {
    sources.set(component, await input.archive(component));
  }

  await fs.mkdir(staging, { mode: 0o700 });
  await fs.mkdir(path.join(staging, 'bin'), { mode: 0o700 });
  await fs.mkdir(path.join(staging, 'update'), { mode: 0o700 });
  await fs.mkdir(path.join(staging, generation), { recursive: true, mode: 0o700 });

  for (const component of components) {
    const directory = path.join(staging, pointer[component]!);
    const artifact = input.envelope.payload.artifacts[component];

    await extractReleaseArtifact(sources.get(component)!, directory, artifact);

    if (component === 'desktop') {
      await materializeMacDesktop(directory, artifact);
    }
  }

  await copyInstallFile(input.maintenance, path.join(staging, 'update/maintenance'));
  await writeInstallationJson(staging, 'installation.json', intent.receipt);
  await writeInstallationJson(staging, generation + '/release.json', input.envelope);

  for (const entry of files) {
    await publishInstallFile(path.join(staging, entry.file), entry.bytes, entry.mode);
  }

  await verifyStage(staging, intent, pointer, files);
  await syncDirectory(path.join(staging, 'bin'));
  await syncDirectory(path.join(staging, 'update'));
  await syncDirectory(path.join(staging, generation));
  await syncDirectory(path.join(staging, 'generations'));
  await syncDirectory(staging);
}

function proofFor(intent: InstallIntent) {
  return {
    format: 1,
    intentSha256: sha256(jsonBytes(intent)),
    files: intent.internal,
    maintenance: intent.maintenance,
  };
}

/**
 * Удаление завершается под тем же installation lock. Проверяется только
 * запись своего manifest и installationId, включая повтор после current.
 */
export async function retireDarwinInstallIntent(
  root: string, manifestDigest: string, installationId: string,
): Promise<void> {
  const intent = await readInstallPublication(intentFile(root)) as InstallIntent | null;

  if (!intent || intent.manifestDigest !== manifestDigest
    || intent.receipt?.installationId !== installationId) {
    return;
  }

  const proof = await readInstallPublication(proofFile(root));
  const verified = proofFor(intent);

  if (proof !== null && canonicalJson(proof) !== canonicalJson(verified)) {
    throw new Error('installation_incomplete_conflict');
  }

  if (proof !== null) {
    await fs.unlink(proofFile(root));
    await syncDirectory(path.dirname(root));
  }

  await fs.unlink(intentFile(root));
  await syncDirectory(path.dirname(root));
}

/**
 * Fresh и recovery работают под одним root lock. До current допустимо
 * продолжить только свою транзакцию с теми же signed bytes и путями.
 */
export async function installDarwinRelease(
  input: InstallReleaseInput, manifestDigest: string, rootExists: boolean,
): Promise<InstallationReceipt> {
  const { root, envelope } = input;
  const saved = await readInstallPublication(intentFile(root)) as InstallIntent | null;
  const proof = await readInstallPublication(proofFile(root));
  const installationId = saved?.receipt?.installationId ?? randomUUID();

  if (!idPattern.test(installationId) || rootExists && (!saved || !proof) || proof && !saved) {
    throw new Error('installation_target_not_empty');
  }

  const receipt: InstallationReceipt = {
    ...installationTrustFields(),
    installationId,
    uid: process.getuid!(),
    root,
    mode: input.mode,
    channel: envelope.payload.channel,
    dataHome: input.dataHome,
    userData: input.userData,
  };
  const generation = `generations/${envelope.payload.version}`;
  const pointer: InstalledPointer = {
    format: 1,
    installationId,
    desktop: input.mode === 'server' ? null : generation + '/desktop',
    server: input.mode === 'remote' ? null : generation + '/server',
  };
  const files = outputs(input, receipt, pointer);
  const internal = [...files.internal, {
    file: 'installation.json',
    bytes: jsonBytes(receipt),
    mode: 0o600,
  }, {
    file: generation + '/release.json',
    bytes: jsonBytes(envelope),
    mode: 0o600,
  }];
  const maintenanceStat = await fs.lstat(input.maintenance);

  if (!maintenanceStat.isFile()) {
    throw new Error('installation_maintenance_invalid');
  }

  const intent: InstallIntent = {
    format: 1,
    manifestDigest,
    receipt,
    staging: root + '.install-stage.' + installationId,
    paths: {
      bin: input.binDirectory,
      applications: input.applicationsDirectory,
      units: input.unitDirectory ?? null,
    },
    published: Object.fromEntries(files.published.map((entry) => [
      entry.file, installationFileProof(entry.bytes, entry.mode),
    ])),
    internal: Object.fromEntries(internal.map((entry) => [
      entry.file, installationFileProof(entry.bytes, entry.mode),
    ])),
    maintenance: {
      mode: 0o555,
      size: maintenanceStat.size,
      sha256: await sha256File(input.maintenance),
    },
  };
  const expectedProof = proofFor(intent);

  if (saved && canonicalJson(saved) !== canonicalJson(intent)
    || proof && canonicalJson(proof) !== canonicalJson(expectedProof)) {
    throw new Error('installation_incomplete_conflict');
  }

  for (const entry of files.published) {
    await assertInstallParents(path.dirname(entry.file));

    if (await lstatOrNull(entry.file)) {
      if (!saved) {
        throw new Error('installation_collision_use_update_status');
      }

      await verifyInstallPublication(entry.file, intent.published[entry.file]!);
    }
  }

  await publishInstallFile(intentFile(root), jsonBytes(intent), 0o600);

  if (!rootExists) {
    if (!proof) {
      await buildStage(input, intent, pointer, internal);
      await publishInstallFile(proofFile(root), jsonBytes(expectedProof), 0o600);
    } else {
      await verifyStage(intent.staging, intent, pointer, internal);
    }

    await publishDarwinInstallStage(intent.staging, root);
  }

  await verifyStage(root, intent, pointer, internal);

  for (const entry of files.published) {
    const directory = path.dirname(entry.file);

    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await assertInstallParents(directory);
    await publishInstallFile(entry.file, entry.bytes, entry.mode);
  }

  await publishInstallFile(path.join(root, 'current.json'), jsonBytes(pointer), 0o600, path.dirname(root));
  await retireDarwinInstallIntent(root, manifestDigest, installationId);

  return receipt;
}
