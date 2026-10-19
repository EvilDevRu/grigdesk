import path from 'node:path';

import type { Plugin } from 'esbuild';

/**
 * Подставляет режим сборки вместо исходного контекста путей.
 * URL helper-а остаётся настоящим import.meta.url конечного ESM-файла.
 */
export function createRuntimeContextPlugin(root: string, mode: 'sea' | 'helper'): Plugin {
  const contextFile = path.join(root, 'server/src/lib/runtimeBuildContext.ts');
  const value = mode === 'sea'
    ? "{ mode: 'sea', execPath: process.execPath }"
    : "{ mode: 'helper', helperUrl: import.meta.url }";

  return {
    name: 'sea-runtime-context',
    setup(build) {
      build.onLoad({ filter: /runtimeBuildContext\.ts$/ }, (args) => {
        if (path.resolve(args.path) !== contextFile) {
          return null;
        }

        return {
          contents: `export function runtimeBuildContext() {\n  return ${value};\n}\n`,
          loader: 'ts',
          resolveDir: path.dirname(contextFile),
        };
      });
    },
  };
}
