import path from 'node:path';
import { existsSync } from 'node:fs';

const FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * CLI этой установки доступны дочерним агентам без симлинков в домашнем каталоге.
 * В рабочей копии утилиты находятся рядом с остальными командами в bin/utilities.
 * Подписанная установка передаёт каталог поколения, подготовленный при запуске.
 */
export function grigDeskCliPath(
    rootDir: string,
    inheritedPath: string | undefined = process.env.PATH,
    binDirectory?: string,
): string {
    const directories = String(inheritedPath || FALLBACK_PATH).split(path.delimiter);

    if (rootDir && path.isAbsolute(rootDir)) {
        const bin = binDirectory ?? path.join(rootDir, 'bin');
        const checkout = path.dirname(bin);

        directories.unshift(bin);

        if (existsSync(path.join(checkout, 'tools/build-go-utilities.sh'))) {
            directories.unshift(path.join(bin, 'utilities'));
        }
    }

    return [...new Set(directories)].join(path.delimiter);
}
