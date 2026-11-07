import { build as buildServer } from 'esbuild';
import { build as buildWeb } from 'vite';
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Готовый payload отделён от dev-проекта и содержит только исполняемые ресурсы.
 * Непустая папка отклоняется, чтобы случайный путь не затёр работу автора.
 */
async function build() {
  const args = process.argv.slice(2);

  if (args.length !== 2 || args[0] !== '--out-dir' || !path.isAbsolute(args[1])) {
    throw new Error('Укажите --out-dir <абсолютная папка payload>');
  }

  const output = path.resolve(args[1]);

  await mkdir(output, { recursive: true });

  if ((await readdir(output)).length) {
    throw new Error('Папка payload должна быть пустой');
  }

  await buildServer({
    entryPoints: [path.join(root, 'src/server.ts')],
    outfile: path.join(output, 'server.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  });
  await buildWeb({
    root,
    configFile: path.join(root, 'vite.config.mjs'),
    build: { outDir: path.join(output, 'ui') },
  });
  await cp(path.join(root, 'assets'), path.join(output, 'assets'), { recursive: true });
  await cp(path.join(root, 'plugin.json'), path.join(output, 'plugin.json'));
}

await build();
