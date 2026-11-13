import { readProductBuildVersion } from '../../../shared/node/releaseBuild.ts';
import { cp, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { makeReadOnlyTree } from '../../../shared/node/files.ts';
import type { NodeRuntime } from '../../../shared/node/nodeRuntime.ts';
import { bundlePayloadServer } from '../sea/bundle.mts';
import { collectLicenses } from '../sea/dependencies.mts';
import { prepareRelease } from '../sea/prepare.mts';
import { auditStage, type PackageFile } from '../sea/stage.mts';
import { prepareOfflineDependencies } from './offlineDependencies.mts';

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
  const required = [
    'server/help/help.json', 'server/help/help.en.json', 'server/help/site/index.html',
    'server/help/site/help.json', 'server/help/site/help.en.json',
    'VERSION', 'runtime/node/bin/node', 'runtime/node/bin/npm',
    'server/package.json', 'server/package-lock.json', 'server/payload.cjs',
    'server/worker-bootstrap.cjs', 'server/runtime/esmBridge.cjs',
    'server/runtime/helpers/helpers.json', 'engine/bin/factory', 'engine/lib/core.sh',
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
}) {
  const resources = JSON.parse(await readFile(
    path.join(input.sourceRoot, 'server/build/binary-resources.json'), 'utf8',
  ));
  const { helpers, dependencies, helpPackages } = await prepareRelease({
    ...input,
    resources,
    install: prepareOfflineDependencies,
  });

  await bundlePayloadServer({
    sourceRoot: input.sourceRoot,
    workDir: input.work,
    outfile: path.join(input.directory, 'server/payload.cjs'),
  });
  await copyFile(input.bootstrap, path.join(input.directory, 'server/worker-bootstrap.cjs'));
  await collectLicenses(input.directory, { extraPackages: helpPackages });
  await cp(path.join(input.directory, 'licenses'), path.join(input.directory, 'server/help/site/licenses'), {
    recursive: true,
  });
  await writeFile(path.join(input.directory, 'VERSION'),
    `${await readProductBuildVersion(input.sourceRoot)}\n`);
  await makeReadOnlyTree(input.directory);

  const compatibility = JSON.parse(await readFile(
    path.join(input.sourceRoot, 'server/build/compatibility.json'), 'utf8',
  ));
  const files = await auditPayload(input.directory, {
    helperIds: helpers.helpers.map((helper) => helper.id),
    dependencies: Object.keys(dependencies.packages),
    native: dependencies.native,
    wrappers: compatibility.wrappers.map((wrapper: { path: string }) => wrapper.path),
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
