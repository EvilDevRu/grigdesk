import { isBuiltin } from 'node:module';
import path from 'node:path';

import { build } from 'esbuild';

/**
 * Launcher встраивает fflate и весь собственный граф, оставляя только Node builtins.
 * Предупреждение или внешний npm import запрещает выпуск автономного ELF.
 */
export async function bundleLauncher(input: {
  sourceRoot: string;
  outfile: string;
  entryPoint?: string;
}) {
  const result = await build({
    absWorkingDir: input.sourceRoot,
    entryPoints: [input.entryPoint ?? 'server/src/binary/main.ts'],
    outfile: input.outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    metafile: true,
    logLevel: 'silent',
  });

  if (result.warnings.length > 0) {
    throw new Error(result.warnings.map((warning) => warning.text).join('\n'));
  }

  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && !isBuiltin(imported.path)) {
        throw new Error(`Внешняя зависимость launcher: ${imported.path}`);
      }
    }
  }

  if (Object.keys(result.metafile.inputs).some((name) => path.isAbsolute(name))) {
    throw new Error('Вход launcher должен быть относительным');
  }

  return result;
}
