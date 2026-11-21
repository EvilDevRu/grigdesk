import { readProductBuildVersion } from '../../../shared/node/releaseBuild.ts';
import { cp, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { makeReadOnlyTree } from '../../../shared/node/files.ts';
import { sha256 } from '../../../shared/node/hash.ts';
import type { NodeRuntime } from '../../../shared/node/nodeRuntime.ts';
import { stageDarwinProcessAssets } from '../../../shared/node/processIdentity.ts';
import { readDarwinBuildSetsid } from '../../../tools/darwinBuildTools.mts';
import { bundlePayloadServer } from '../sea/bundle.mts';
import type { CompatibilityManifest } from '../sea/compatibility.mts';
import { collectLicenses } from '../sea/dependencies.mts';
import { prepareRelease } from '../sea/prepare.mts';
import { auditStage, type PackageFile } from '../sea/stage.mts';
import { prepareOfflineDependencies } from './offlineDependencies.mts';
import { stageFactoryCandidate } from './factoryCandidate.mts';
import {
  FACTORY_GO_DESCRIPTOR, FACTORY_PROFILE_ABI, readFactoryGoDescriptor,
} from '../../src/lib/factoryGoDescriptor.ts';
import type { ResourceManifest } from '../sea/resources.mts';

export interface PayloadAuditOptions {
  helperIds: readonly string[];
  dependencies: readonly string[];
  native: readonly string[];
  wrappers?: readonly string[];
  sourceRoot?: string;
  forbiddenRoots?: readonly string[];
}

/**
 * Payload замкнут на собственный CJS, ordinary Node и явные ресурсы движка.
 * Внешние утилиты, исходники и UI не становятся скрытой зависимостью одного ELF.
 */
export async function auditPayload(root: string, options: PayloadAuditOptions): Promise<PackageFile[]> {
  const factory = readFactoryGoDescriptor(root);

  if (!factory) {
    throw new Error('В payload отсутствует проверенный Go-движок фабрики');
  }

  const required = [
    'server/help/help.json', 'server/help/help.en.json', 'server/help/site/index.html',
    'server/help/site/help.json', 'server/help/site/help.en.json',
    'VERSION', 'runtime/node/bin/node', 'runtime/node/bin/npm',
    'server/package.json', 'server/package-lock.json', 'server/payload.cjs',
    'server/worker-bootstrap.cjs', 'server/runtime/esmBridge.cjs',
    'server/runtime/helpers/helpers.json', 'engine/bin/factory',
    FACTORY_PROFILE_ABI, FACTORY_GO_DESCRIPTOR,
    'tools/skills/grigdesk-connect-project/SKILL.md',
    'schemas/analytics/lifecycle-event.schema.json',
    'schemas/analytics/provider-lineage.schema.json', 'schemas/analytics/usage-document.schema.json',
    'deploy/require-vpn.sh', 'licenses/NODE.txt', 'licenses/THIRD-PARTY.json',
    ...options.helperIds.map((id) => `server/runtime/helpers/${id}.mjs`),
    ...options.dependencies.map((name) => `server/node_modules/${name}/package.json`),
    ...options.native,
  ];
  const allowed = new Set([
    'VERSION', 'runtime', 'server', 'engine', 'schemas', 'deploy', 'licenses', 'tools',
  ]);

  for (const name of await readdir(root)) {
    if (!allowed.has(name)) {
      throw new Error(`Запрещён корень состава payload: ${name}`);
    }
  }

  const files = await auditStage(root, {
    required,
    allowedSources: options.wrappers ?? [],
    sourceRoot: options.sourceRoot,
    forbiddenRoots: options.forbiddenRoots,
  });

  if (files.some((file) => file.path.startsWith('engine/')
    && file.path !== factory.path && file.path !== FACTORY_PROFILE_ABI)) {
    throw new Error('Go payload содержит лишний файл в engine/');
  }

  if (files.some((file) => file.path.startsWith('tools/') && !file.path.startsWith('tools/skills/'))) {
    throw new Error('Запрещён ресурс tools вне встроенных навыков payload');
  }

  if (files.some((file) => file.path === 'server/grigdesk-server'
    || file.path.startsWith('server/src/') && /\.[cm]?[jt]sx?$/.test(file.path))) {
    throw new Error('Запрещён вложенный ELF или собственный исходник в payload');
  }

  return files;
}

/**
 * Существующие стадии готовят обычный Node, CJS, полный каталог helpers и ресурсы.
 * До финального индекса удалены build outputs и выставлены окончательные read-only modes.
 */
export async function buildPayload(input: {
  sourceRoot: string;
  directory: string;
  archive: string;
  runtime: NodeRuntime;
  cacheDir: string;
  work: string;
  bootstrap: string;
  factoryCandidate?: string;
}) {
  if (!input.factoryCandidate) {
    throw new Error('Поставка требует собранный Go-движок фабрики');
  }

  const resources: ResourceManifest = JSON.parse(await readFile(
    path.join(input.sourceRoot, 'server/build/binary-resources.json'), 'utf8',
  ));
  const compatibility: CompatibilityManifest = JSON.parse(await readFile(
    path.join(input.sourceRoot, 'server/build/compatibility.json'), 'utf8',
  ));

  const { helpers, dependencies, helpPackages } = await prepareRelease({
    ...input,
    resources,
    compatibility,
    install: prepareOfflineDependencies,
  });

  const [os, arch] = input.runtime.platform.split('-') as [string, string];

  await stageFactoryCandidate({
    root: input.directory,
    binary: input.factoryCandidate,
    profileAbi: path.join(input.sourceRoot, FACTORY_PROFILE_ABI),
    os,
    arch,
  });

  await bundlePayloadServer({
    sourceRoot: input.sourceRoot,
    workDir: input.work,
    outfile: path.join(input.directory, 'server/payload.cjs'),
  });
  await copyFile(input.bootstrap, path.join(input.directory, 'server/worker-bootstrap.cjs'));

  if (input.runtime.platform === 'darwin-arm64') {
    const directory = path.join(input.directory, 'server/runtime/darwin-tools');
    const setsid = await readDarwinBuildSetsid(process.env);
    const bytes = await readFile(setsid);
    const digest = sha256(bytes);

    if (digest !== process.env.GRIGDESK_BUILD_SETSID_SHA256) {
      throw new Error('darwin_build_tool_invalid');
    }

    await mkdir(directory, { mode: 0o700 });
    await stageDarwinProcessAssets(directory);
    await writeFile(path.join(directory, 'setsid'), bytes, { flag: 'wx', mode: 0o500 });
    await writeFile(path.join(directory, 'setsid.sha256'), digest, { flag: 'wx', mode: 0o400 });
  }

  await collectLicenses(input.directory, { extraPackages: helpPackages });
  await cp(path.join(input.directory, 'licenses'), path.join(input.directory, 'server/help/site/licenses'), {
    recursive: true,
  });
  await writeFile(path.join(input.directory, 'VERSION'),
    `${await readProductBuildVersion(input.sourceRoot)}\n`);
  await makeReadOnlyTree(input.directory);

  const files = await auditPayload(input.directory, {
    helperIds: helpers.helpers.map((helper) => helper.id),
    dependencies: Object.keys(dependencies.packages),
    native: dependencies.native,
    wrappers: compatibility.wrappers.map((wrapper) => wrapper.path),
    sourceRoot: input.sourceRoot,
    forbiddenRoots: [input.cacheDir, input.directory, input.work],
  });

  if (dependencies.native.length !== 2) {
    throw new Error('Payload требует два проверенных native bindings');
  }

  return {
    files,
    dependencies,
    helpers,
  };
}
