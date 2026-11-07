import path from 'node:path';

const FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * CLI этой установки доступны дочерним агентам без симлинков в домашнем каталоге.
 * Абсолютный bin не зависит от cwd задачи; повторная подготовка не дублирует путь.
 */
export function grigDeskCliPath(
    rootDir: string,
    inheritedPath: string | undefined = process.env.PATH,
    binDirectory?: string,
): string {
    const directories = String(inheritedPath || FALLBACK_PATH).split(path.delimiter);

    if (rootDir && path.isAbsolute(rootDir)) {
        directories.unshift(binDirectory ?? path.join(rootDir, 'bin'));
    }

    return [...new Set(directories)].join(path.delimiter);
}
