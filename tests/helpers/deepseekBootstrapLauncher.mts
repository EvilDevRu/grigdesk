import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getRawAsset } from 'node:sea';

import { Unzip, UnzipInflate } from '../../deepseek/node_modules/fflate/esm/index.mjs';

interface BootstrapEntry {
  name: string;
  type: 'file' | 'dir' | 'link';
  mode: number;
  target?: string;
}

interface BootstrapManifest {
  entry: string;
  harnessEntry?: string;
  entries: BootstrapEntry[];
}

/**
 * Bootstrap извлекает доверенный payload технической пробы, сохраняя modes и ссылки.
 * Полная проверка индекса, identity и атомарная публикация появятся до production cutover.
 */
function extractBootstrap(cache: string, manifest: BootstrapManifest): void {
  if (existsSync(path.join(cache, 'bootstrap-ready'))) {
    return;
  }

  mkdirSync(cache, { recursive: true, mode: 0o700 });

  const entries = new Map(manifest.entries.map((entry) => [entry.name, entry]));

  for (const entry of manifest.entries.filter((entry) => entry.type === 'dir')) {
    mkdirSync(path.join(cache, entry.name), { recursive: true, mode: entry.mode });
  }

  const unzip = new Unzip((file) => {
    const entry = entries.get(file.name);

    if (!entry || entry.type !== 'file') {
      throw new Error('Неизвестная запись bootstrap payload');
    }

    const target = path.join(cache, entry.name);

    mkdirSync(path.dirname(target), { recursive: true });

    const descriptor = openSync(target, 'wx', entry.mode);

    file.ondata = (error, bytes, final) => {
      if (error) {
        closeSync(descriptor);

        throw error;
      }

      writeFileSync(descriptor, bytes);

      if (final) {
        closeSync(descriptor);
        chmodSync(target, entry.mode);
      }
    };
    file.start();
  });

  unzip.register(UnzipInflate);

  const asset = getRawAsset('payload.zip');

  for (let offset = 0; offset < asset.byteLength; offset += 65536) {
    const length = Math.min(65536, asset.byteLength - offset);

    unzip.push(new Uint8Array(asset, offset, length), offset + length === asset.byteLength);
  }

  for (const entry of manifest.entries.filter((entry) => entry.type === 'link')) {
    symlinkSync(entry.target!, path.join(cache, entry.name));
  }

  writeFileSync(path.join(cache, 'bootstrap-ready'), 'S01\n', { mode: 0o600 });
}

/**
 * Launcher запускает обычный извлечённый Node, поэтому вложенные JS workers не входят в SEA снова.
 * Потоки наследуются напрямую; завершение launcher ждёт фактического выхода своего worker.
 */
async function main(): Promise<void> {
  const [flag, cache, ...args] = process.argv.slice(2);

  if (flag !== '--cache-dir' || !cache || !path.isAbsolute(cache)) {
    throw new Error('Техническая проба требует абсолютный --cache-dir');
  }

  const manifest: BootstrapManifest = JSON.parse(Buffer.from(getRawAsset('manifest.json')).toString('utf8'));

  extractBootstrap(cache, manifest);

  const workerArgs = [path.join(cache, manifest.entry),
    ...(manifest.harnessEntry ? [path.join(cache, manifest.harnessEntry)] : []), ...args];
  const worker = spawn(path.join(cache, 'node'), workerArgs, {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: process.env,
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let escalated = false;
  const forward = (signal: NodeJS.Signals) => {
    if (timeout) {
      return;
    }

    worker.kill(signal);
    timeout = setTimeout(() => {
      escalated = true;
      worker.kill('SIGKILL');
    }, 4000);
  };

  process.once('SIGTERM', () => forward('SIGTERM'));
  process.once('SIGINT', () => forward('SIGINT'));

  if (process.send) {
    process.send({ type: 'bootstrap-worker', pid: worker.pid });
  }

  const code = await new Promise<number | null>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', resolve);
  });

  clearTimeout(timeout);
  process.exitCode = escalated ? 75 : code ?? 75;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
