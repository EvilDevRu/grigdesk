import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { build } from '../../deepseek/node_modules/esbuild/lib/main.js';

import { withWorkDirectory } from '../../shared/node/files.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { nodeArchive, seaConfig } from '../../shared/node/seaBuild.ts';

import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { Zip, ZipDeflate } from '../../deepseek/node_modules/fflate/esm/index.mjs';

export interface BootstrapBuildOptions {
  payloadDirectory: string;
  entry: string;
  outputFile: string;
  workDirectory: string;
  nodeArchive: string;
  ipcBootstrap?: boolean;
}

const packageDirectory = fileURLToPath(new URL('../../deepseek/', import.meta.url));
const repositoryRoot = path.resolve(packageDirectory, '..');
const run = promisify(execFile);
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const workerBootstrapSource = String.raw`
import { access, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];

process.argv = [process.argv[0], ...process.argv.slice(2)];

/**
 * Disconnect наблюдается до импорта Harness и переводит worker в его штатный SIGTERM disposal.
 * При смерти launcher во время boot сигнал завершит worker до запуска управляемых команд.
 */
function requestStop() {
  process.kill(process.pid, 'SIGTERM');
}

process.once('disconnect', requestStop);

if (!process.connected) {
  process.exit(0);
}

const profile = process.argv.indexOf('--profile');

if (profile >= 0 && process.argv[profile + 1] === 'acp') {
  process.stdin.once('end', requestStop);
}

// Только технический bootstrap S01: барьер доказывает смерть до импорта Harness.
const barrier = process.env.GRIGDESK_TEST_BOOT_GATE;

if (barrier) {
  await writeFile(barrier + '.ready', String(process.pid));

  while (!await access(barrier).then(() => true, () => false)) {
    await pause(25);
  }
}

await import(pathToFileURL(entry).href);
`;

/**
 * Минимальная сборка должна включить обычный worker Node и переданный ESM payload.
 * На стадии S01 выход разрешён только в одноразовые каталоги артефактов.
 */
export async function buildBootstrapBinary(options: BootstrapBuildOptions): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Пробная SEA сборка поддерживает только Linux x64');
  }

  const output = path.resolve(options.outputFile);

  if (output.startsWith(`${path.join(repositoryRoot, 'bin')}${path.sep}`)) {
    throw new Error('До завершения пробы S01 публикация в bin запрещена');
  }

  const pin = JSON.parse(await readFile(path.join(packageDirectory, 'build/node-runtime.json'), 'utf8'));

  if (await sha256File(options.nodeArchive) !== pin.sha256) {
    throw new Error('SHA256 закреплённого архива Node не совпадает');
  }

  const { directory } = nodeArchive(pin);

  await withWorkDirectory(options.workDirectory, async (work) => {
    await run('tar', ['-xJf', options.nodeArchive, '-C', work, '--strip-components=1',
      `${directory}/bin/node`, `${directory}/LICENSE`]);

    const entries = await inventory(options.payloadDirectory, 'generation');

    entries.unshift({
      name: 'generation',
      type: 'dir',
      mode: 0o755,
    });
    entries.push({
      name: 'node',
      type: 'file',
      mode: 0o755,
      source: path.join(work, 'bin/node'),
    });

    if (options.ipcBootstrap) {
      await writeFile(path.join(work, 'worker-bootstrap.mjs'), workerBootstrapSource);
      entries.push({
        name: 'worker-bootstrap.mjs',
        type: 'file',
        mode: 0o644,
        source: path.join(work, 'worker-bootstrap.mjs'),
      });
    }

    await writeFile(path.join(work, 'manifest.json'), JSON.stringify({
      entry: options.ipcBootstrap ? 'worker-bootstrap.mjs' : path.posix.join('generation', options.entry),
      harnessEntry: options.ipcBootstrap ? path.posix.join('generation', options.entry) : undefined,
      entries: entries.map(({ source: _source, ...entry }) => entry),
    }));
    await writePayload(entries, path.join(work, 'payload.zip'));
    await build({
      entryPoints: [fileURLToPath(new URL('./deepseekBootstrapLauncher.mts', import.meta.url))],
      outfile: path.join(work, 'bundle.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent',
    });
    await writeFile(path.join(work, 'sea-config.json'), JSON.stringify(seaConfig({
      'manifest.json': 'manifest.json',
      'payload.zip': 'payload.zip',
    })));
    await run(path.join(work, 'bin/node'), ['--experimental-sea-config', 'sea-config.json'], {
      cwd: work,
      maxBuffer: 4 * 1024 * 1024,
    });
    await copyFile(path.join(work, 'bin/node'), path.join(work, 'deepseek'));
    await run(process.execPath, [path.join(packageDirectory, 'node_modules/postject/dist/cli.js'),
      'deepseek', 'NODE_SEA_BLOB', 'sea-prep.blob', '--sentinel-fuse', fuse], {
      cwd: work,
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    await chmod(path.join(work, 'deepseek'), 0o755);
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(path.join(work, 'deepseek'), output);
    await chmod(output, 0o755);
  });
}

export interface PayloadEntry {
  name: string;
  type: 'file' | 'dir' | 'link';
  mode: number;
  source?: string;
  target?: string;
}

export { nativeSource } from './deepseekNativeProbes.mts';

/**
 * Индекс пробы сохраняет modes и внутренние ссылки без адресов исходной сборки.
 * Проверка запрещает упаковку внешней ссылки из production generation.
 */
export async function inventory(directory: string, prefix: string): Promise<PayloadEntry[]> {
  const entries: PayloadEntry[] = [];

  for (const name of (await readdir(directory)).sort()) {
    const source = path.join(directory, name);
    const relative = path.posix.join(prefix, name);
    const info = await lstat(source);
    const mode = info.mode & 0o777;

    if (info.isDirectory()) {
      entries.push({
        name: relative,
        type: 'dir',
        mode,
      });
      entries.push(...await inventory(source, relative));
    } else if (info.isFile()) {
      entries.push({
        name: relative,
        type: 'file',
        mode,
        source,
      });
    } else if (info.isSymbolicLink()) {
      const target = await readlink(source);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));

      if (path.isAbsolute(target) || !resolved.startsWith('generation/')) {
        throw new Error(`Внешняя ссылка в пробном payload: ${relative}`);
      }

      entries.push({
        name: relative,
        type: 'link',
        mode,
        target,
      });
    } else {
      throw new Error(`Специальный файл в пробном payload: ${relative}`);
    }
  }

  return entries;
}

/**
 * Стандартный ZIP пишется и сжимается частями, без копии generation в памяти.
 * Ограничение буфера выходного файла удерживает RSS упаковки независимо от объёма payload.
 */
export async function writePayload(entries: PayloadEntry[], target: string): Promise<void> {
  const output = createWriteStream(target, { mode: 0o600 });
  const complete = finished(output);
  let buffered = false;
  const zip = new Zip((error, bytes, final) => {
    if (error) {
      output.destroy(error);

      return;
    }

    buffered = !output.write(bytes) || buffered;

    if (final) {
      output.end();
    }
  });

  for (const entry of entries.filter((entry) => entry.type === 'file')) {
    const stream = new ZipDeflate(entry.name, { level: 6 });

    zip.add(stream);

    for await (const chunk of createReadStream(entry.source!)) {
      stream.push(chunk, false);

      if (buffered) {
        await once(output, 'drain');
        buffered = false;
      }
    }

    stream.push(new Uint8Array(), true);

    if (buffered) {
      await once(output, 'drain');
      buffered = false;
    }
  }

  zip.end();
  await complete;
}

