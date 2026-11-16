import path from 'node:path';
import { build } from 'esbuild';

import { buildCliBinary } from '../../shared/node/cliSeaBuild.ts';
import { parseBuildArgs } from './buildSteps.mts';
import type { BuildOptions } from './buildSteps.mts';

const packageDir = path.resolve(import.meta.dirname, '..');

/**
 * Выбирает один из двух входов общего пакета tracker и pipeline.
 * Сам протокол SEA и атомарная публикация принадлежат общему сборщику.
 */
export async function buildBinary(
    options: BuildOptions,
    program: 'tracker' | 'pipeline' = 'tracker',
): Promise<void> {
    await buildCliBinary({
        packageDir,
        program,
        entry: program === 'pipeline' ? 'pipelineMain.ts' : 'main.ts',
        options,
        bundle: build,
    });
}
/**
 * Оболочка командной строки: аргументы проверяются до эффектов.
 * Ошибка аргументов — код 2, ошибка сборки — код 1 и русская причина.
 */
async function main(): Promise<void> {
    const parsed = parseBuildArgs(process.argv.slice(2), process.cwd(), packageDir);

    if ('error' in parsed) {
        process.stderr.write(`${parsed.error}\n`);
        process.exitCode = 2;

        return;
    }

    try {
        await buildBinary(parsed);
    }
    catch (error) {
        process.stderr.write(`Сборка tracker не удалась: ${(error as Error).message}\n`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(packageDir, 'scripts/build.mts')) {
    void main();
}
