import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { config } from '../src/config.ts';
import { DEEPSEEK_PIN } from '../src/lib/deepseek/contract.ts';
import { ensurePrivateDir } from '../src/lib/deepseek/env.ts';

const execFileAsync = promisify(execFile);

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Не задано значение ${name}`);
  return value;
}

async function readJson(file: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, any>;
}

async function verifyInstall(prefix: string): Promise<void> {
  const packageDir = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh');
  const packageJson = await readJson(path.join(packageDir, 'package.json'));
  const lock = await readJson(path.join(prefix, 'package-lock.json'));
  const locked = lock.packages?.['node_modules/@deepseek-ai/dsh'];

  if (packageJson.version !== DEEPSEEK_PIN.version || locked?.version !== DEEPSEEK_PIN.version) {
    throw new Error(`deepseek install: ожидалась версия ${DEEPSEEK_PIN.version}`);
  }
  if (locked.integrity !== DEEPSEEK_PIN.integrity) {
    throw new Error('deepseek install: integrity pinned-артефакта не совпадает');
  }
}

async function switchCurrent(installRoot: string): Promise<void> {
  const current = path.join(installRoot, 'current');
  const temporary = path.join(installRoot, `.current-${process.pid}-${randomUUID()}`);
  await fs.symlink(DEEPSEEK_PIN.version, temporary, 'dir');
  try {
    await fs.rename(temporary, current);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function installDeepSeekHarness({
  runtimeHome = config.deepseekRuntimeHome,
  npmBin = 'npm',
}: {
  runtimeHome?: string;
  npmBin?: string;
} = {}): Promise<{ version: string; directory: string; current: string }> {
  const resolvedHome = path.resolve(runtimeHome);
  const installRoot = path.join(resolvedHome, 'install');
  const versionDir = path.join(installRoot, DEEPSEEK_PIN.version);
  const staging = path.join(installRoot, `staging-${process.pid}-${randomUUID()}`);

  await ensurePrivateDir(resolvedHome);
  await ensurePrivateDir(installRoot);

  try {
    try {
      await verifyInstall(versionDir);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
      if (!missing) throw error;

      await ensurePrivateDir(staging);
      await execFileAsync(npmBin, [
        'install',
        '--prefix', staging,
        '--no-audit',
        '--no-fund',
        '--save-exact',
        `@deepseek-ai/dsh@${DEEPSEEK_PIN.version}`,
      ], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      await verifyInstall(staging);
      await fs.rename(staging, versionDir);
    }

    await switchCurrent(installRoot);
    return {
      version: DEEPSEEK_PIN.version,
      directory: versionDir,
      current: path.join(installRoot, 'current'),
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const runtimeHome = argumentValue('--runtime-home') || config.deepseekRuntimeHome;
  const installed = await installDeepSeekHarness({ runtimeHome });
  process.stdout.write(`DeepSeek Harness ${installed.version} установлен\n`);
}
