import { writeHelpResources } from '../help/writeHelpResources.mts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { NodeRuntime } from '../../../shared/node/nodeRuntime.ts';
import { writeCompatibility } from './compatibility.mts';
import { assertRuntimeDependencies, cleanNativeBuilds, extractRuntime, installDependencies,
  probeDependencies, runtimeSpecifiers } from './dependencies.mts';
import { buildHelper, loadHelpers } from './helpers.mts';
import { copyResources, type ResourceManifest } from './resources.mts';

/**
 * Общая подготовка Node, npm, ресурсов и helpers сохраняет прежний порядок SEA.
 * Выбор формы сервера и самостоятельных CLI остаётся у вызывающего сборщика.
 */
export async function prepareRelease(input: {
  sourceRoot: string;
  directory: string;
  archive: string;
  runtime: NodeRuntime;
  cacheDir: string;
  work: string;
  resources?: ResourceManifest;
  install?: typeof installDependencies;
}) {
  const directory = input.directory;

  /**
   * Публичные сборочные контракты читаются из явно переданного checkout.
   * Входные пути не попадают в подготовленный payload.
   */
  async function json(relative: string) {
    return JSON.parse(await readFile(path.join(input.sourceRoot, relative), 'utf8'));
  }

  process.stdout.write('SEA: runtime и production dependencies\n');
  assertRuntimeDependencies(await json('server/package.json'), await runtimeSpecifiers(
    input.sourceRoot, ['server/src', 'shared/runtime'],
  ));
  await extractRuntime({
    archive: input.archive,
    runtime: input.runtime,
    target: path.join(directory, 'runtime/node'),
  });
  await (input.install ?? installDependencies)({
    sourceRoot: input.sourceRoot,
    stageRoot: directory,
    cacheDir: path.resolve(
      process.env.npm_config_cache ?? path.join(input.cacheDir, 'npm'),
    ),
  });
  await cleanNativeBuilds(directory);

  const dependencies = await probeDependencies(directory);

  if (dependencies.node !== input.runtime.version || dependencies.abi !== '137') {
    throw new Error(`Неверный runtime dependencies: ${JSON.stringify(dependencies)}`);
  }

  const resources = input.resources ?? await json('server/build/resources.json');

  await copyResources(input.sourceRoot, directory, resources);

  const helpPackages = await writeHelpResources(input);

  const helpers = await loadHelpers(
    path.join(input.sourceRoot, 'server/build/helpers.json'), input.sourceRoot,
  );

  for (const helper of helpers.helpers) {
    process.stdout.write(`SEA: helper ${helper.id}\n`);
    await buildHelper({
      manifest: helpers,
      id: helper.id,
      root: input.sourceRoot,
      outDir: path.join(directory, 'server/runtime/helpers'),
      workDir: path.join(input.work, 'helpers'),
    });
  }

  await writeCompatibility(directory, await json('server/build/compatibility.json'), helpers);

  return {
    helpers,
    dependencies,
    helpPackages,
  };
}
