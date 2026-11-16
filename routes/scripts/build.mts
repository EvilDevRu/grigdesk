import path from 'node:path';
import { build } from 'esbuild';

import { buildCliBinary } from '../../shared/node/cliSeaBuild.ts';
import { parseCliBuildArgs } from '../../shared/node/cliBuildArgs.ts';
import type { CliBuildOptions } from '../../shared/node/cliBuildArgs.ts';

const packageDir = path.resolve(import.meta.dirname, '..');

/**
 * Собирает только routes из собственного пакета и закреплённого Node.
 * Зависимости tracker и его точки входа здесь не используются.
 */
export async function buildBinary(options: CliBuildOptions): Promise<void> {
    await buildCliBinary({
        packageDir,
        program: 'routes',
        entry: 'main.ts',
        options,
        bundle: build,
    });
}

/**
 * Аргументы проверяются до чтения кэша, сети и записи результата.
 * Ошибка сборки сохраняет прежний ELF и возвращает русскую причину.
 */
async function main(): Promise<void> {
    const parsed = parseCliBuildArgs(process.argv.slice(2), process.cwd(), packageDir);

    if ('error' in parsed) {
        process.stderr.write(parsed.error + '\n');
        process.exitCode = 2;

        return;
    }

    try {
        await buildBinary(parsed);
    } catch (error) {
        process.stderr.write('Сборка routes не удалась: ' + (error as Error).message + '\n');
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(packageDir, 'scripts/build.mts')) {
    void main();
}
