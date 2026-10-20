import path from 'node:path';

import { build } from 'esbuild';
import type { BuildResult, Metafile, Plugin } from 'esbuild';

import { SEA_REQUIRE_BANNER } from './buildSteps.mts';
import { createRuntimeContextPlugin } from './context.mts';
import { createModuleUrlsPlugin } from './moduleUrls.mts';
import { engineEntries, executorEntries, renderEngineTable, renderExecutorTable } from './registries.mts';

export interface ServerBundleInput {
  sourceRoot: string;
  workDir: string;
  outfile: string;
  plugins?: Plugin[];
}

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
async function bundleServerGraph(
  input: ServerBundleInput,
  mode: 'sea' | 'payload',
): Promise<BuildResult & { metafile: Metafile }> {
  const urls = createModuleUrlsPlugin({
    root: input.sourceRoot,
    runtimeModule: path.join(input.sourceRoot, 'server/src/lib/runtimePaths.ts'),
  });
  const result = await build({
    absWorkingDir: input.sourceRoot,
    entryPoints: [mode === 'sea' ? 'server/src/sea.ts' : 'server/src/binary/serverEntry.ts'],
    outfile: input.outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    packages: 'external',
    banner: {
      js: mode === 'sea' ? SEA_REQUIRE_BANNER : "require = require('node:module').createRequire(__filename);",
    },
    plugins: [...input.plugins ?? [], registryPlugin(input.sourceRoot),
      createRuntimeContextPlugin(input.sourceRoot, mode),
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

/**
 * Прежний SEA сохраняет свой entry и require от физического execPath.
 * Общий граф реестров и URL теперь используется также ordinary Node payload.
 */
export function bundleServer(input: ServerBundleInput): Promise<BuildResult & { metafile: Metafile }> {
  return bundleServerGraph(input, 'sea');
}

/**
 * CJS payload экспортирует ленивый entry и привязывает require к собственному файлу.
 * Node launcher и рабочий ordinary Node остаются отдельными от графа приложения.
 */
export function bundlePayloadServer(input: ServerBundleInput): Promise<BuildResult & { metafile: Metafile }> {
  return bundleServerGraph(input, 'payload');
}
