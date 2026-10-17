import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE = fileURLToPath(new URL('../../../b24/', import.meta.url));
export const BUILD_SCRIPT = path.join(PACKAGE, 'scripts/build.mts');

const ARCHIVE = 'node-v24.21.0-linux-x64.tar.xz';
const BUILD_TIMEOUT_MS = 12 * 60 * 1000;

export interface SeaCandidate {
  binary: string;
  explicit: boolean;
  cleanup(): Promise<void>;
}

export interface BuildRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Запускает build.mts отдельным процессом с ограниченным сроком.
 * Тайм-аут считается отказом: ребёнок убивается, код null.
 */
export async function runBuild(args: readonly string[]): Promise<BuildRun> {
  const child = spawn(process.execPath, [BUILD_SCRIPT, ...args], {
    cwd: PACKAGE,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: os.tmpdir(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, BUILD_TIMEOUT_MS);

  try {
    return await new Promise<BuildRun>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        resolve({
          code,
          stdout,
          stderr,
        });
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Готовит проверяемый файл: явный COCKPIT_B24_TEST_BINARY или свежую сборку в mkdtemp.
 * Кэш b24/.cache только копируется — build.mts заново сверяет SHA256; иначе качается pin.
 */
export async function prepareCandidate(): Promise<SeaCandidate> {
  const explicit = process.env.COCKPIT_B24_TEST_BINARY;

  if (explicit !== undefined) {
    if (!path.isAbsolute(explicit)) {
      throw new Error('COCKPIT_B24_TEST_BINARY должен быть абсолютным путём');
    }

    await access(explicit, constants.X_OK);

    if (!(await stat(explicit)).isFile()) {
      throw new Error('COCKPIT_B24_TEST_BINARY должен указывать на файл');
    }

    return {
      binary: explicit,
      explicit: true,
      cleanup: async () => undefined,
    };
  }

  const work = await mkdtemp(path.join(os.tmpdir(), 'b24-sea-build-'));
  const cache = path.join(work, 'cache');
  const out = path.join(work, 'out');
  const cached = path.join(PACKAGE, '.cache', ARCHIVE);

  await mkdir(cache, { recursive: true });
  await copyFile(cached, path.join(cache, ARCHIVE)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });

  const result = await runBuild(['--out-dir', out, '--cache-dir', cache]);

  if (result.code !== 0) {
    throw new Error(`Сборка кандидата не удалась (${String(result.code)}): ${result.stderr}`);
  }

  return {
    binary: path.join(out, 'b24'),
    explicit: false,
    cleanup: async () => {
      await rm(work, {
        recursive: true,
        force: true,
      });
    },
  };
}
