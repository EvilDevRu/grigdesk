import path from 'node:path';

export interface CliBuildOptions {
  outDir: string;
  cacheDir: string;
}


const FLAGS = new Map<string, keyof CliBuildOptions>([
  ['--out-dir', 'outDir'],
  ['--cache-dir', 'cacheDir'],
]);

/**
 * Разбирает каталоги сборки до сетевых и файловых эффектов.
 * Относительный путь относится к cwd процесса; повтор, пустое значение и чужой флаг — ошибка.
 */
export function parseCliBuildArgs(args: readonly string[], cwd: string, packageDir: string):
  CliBuildOptions | { error: string } {
  const root = path.resolve(packageDir, '..');
  const name = path.basename(packageDir);
  const usage = `Использование: npm --prefix ${name} run build -- `
    + '[--out-dir <каталог>] [--cache-dir <каталог>]';
  const result: CliBuildOptions = {
    outDir: path.join(root, 'bin'),
    cacheDir: path.join(packageDir, '.cache'),
  };
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 2) {
    const key = FLAGS.get(args[index] ?? '');
    const value = args[index + 1];

    if (!key || seen.has(key) || !value || value.startsWith('--')) {
      return { error: usage };
    }

    seen.add(key);
    result[key] = path.resolve(cwd, value);
  }

  return result;
}

