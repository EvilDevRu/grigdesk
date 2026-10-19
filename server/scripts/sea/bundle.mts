import path from 'node:path';

import { build } from 'esbuild';
import type { BuildResult, Metafile, Plugin } from 'esbuild';

import { SEA_REQUIRE_BANNER } from './buildSteps.mts';
import { createRuntimeContextPlugin } from './context.mts';
import { createModuleUrlsPlugin } from './moduleUrls.mts';
import { engineEntries, executorEntries, renderEngineTable, renderExecutorTable } from './registries.mts';

/**
 * Подменяет только таблицы сборки, не записывая сгенерированный код в исходники.
 * Относительные импорты разрешаются от прежнего каталога таблицы, без абсолютных строк в bundle.
 */
function registryPlugin(root: string): Plugin {
  const executors = path.join(root, 'server/src/lib/executors');
  const database = path.join(root, 'server/src/lib/db');
  const sources = new Map([
    [path.join(root, 'server/src/lib/releaseServices.ts'),
      "export { createPackagedServices as createReleaseServices } from './packagedRelease.ts';"],
    [path.join(executors, 'registryTable.ts'), renderExecutorTable(
      executorEntries(executors), path.join(executors, 'registryTable.ts'),
    )],
    [path.join(database, 'engineTable.ts'), renderEngineTable(
      engineEntries(path.join(database, 'engines')), path.join(database, 'engineTable.ts'),
    )],
  ]);

  return {
    name: 'sea-registries',
    setup(builder) {
      builder.onLoad({ filter: /(?:registryTable|engineTable|releaseServices)\.ts$/ }, (args) => {
        const contents = sources.get(path.resolve(args.path));

        return contents ? {
          contents,
          loader: 'ts',
          resolveDir: path.dirname(args.path),
        } : null;
      });
    },
  };
}

/**
 * Собирает весь собственный CJS-граф; внешними остаются только npm и builtin.
 * Любое предупреждение или наружный собственный import запрещает подготовку SEA blob.
 */
export async function bundleServer(input: {
  sourceRoot: string;
  workDir: string;
  outfile: string;
}): Promise<BuildResult & { metafile: Metafile }> {
  const urls = createModuleUrlsPlugin({
    root: input.sourceRoot,
    runtimeModule: path.join(input.sourceRoot, 'server/src/lib/runtimePaths.ts'),
  });
  const result = await build({
    absWorkingDir: input.sourceRoot,
    entryPoints: ['server/src/sea.ts'],
    outfile: input.outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    packages: 'external',
    banner: { js: SEA_REQUIRE_BANNER },
    plugins: [registryPlugin(input.sourceRoot), createRuntimeContextPlugin(input.sourceRoot, 'sea'),
      urls.plugin],
    metafile: true,
    logLevel: 'silent',
  });

  if (result.warnings.length > 0) {
    throw new Error(result.warnings.map((warning) => warning.text).join('\n'));
  }

  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && (imported.path.startsWith('.') || path.isAbsolute(imported.path))) {
        throw new Error(`Незамкнутый собственный import: ${imported.path}`);
      }
    }
  }

  return result;
}
