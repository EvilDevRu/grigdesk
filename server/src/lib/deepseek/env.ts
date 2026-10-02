import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { probeDeepSeekRuntime } from './runtimeProcess.ts';

const PASSTHROUGH_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const;

export interface DeepSeekEnvError extends Error {
  code: 'deepseek_api_key_missing';
}

function envError(message: string): DeepSeekEnvError {
  const error = new Error(message) as DeepSeekEnvError;
  error.code = 'deepseek_api_key_missing';
  return error;
}

/** Окружение DSH строится allowlist-ом: чужие provider credentials и proxy не наследуются. */
export function buildDeepSeekChildEnv({
  source,
  dshHome,
}: {
  source: NodeJS.ProcessEnv | Record<string, string | undefined>;
  dshHome: string;
}): Record<string, string> {
  const apiKey = source.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw envError('Для DeepSeek нужен DEEPSEEK_API_KEY в окружении службы');
  }
  if (!path.isAbsolute(dshHome)) {
    throw new TypeError('DSH_HOME должен быть абсолютным путём');
  }

  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0 && !value.includes('\0')) {
      env[key] = value;
    }
  }
  env.DSH_HOME = dshHome;
  env.DSH_TELEMETRY_DISABLED = '1';
  env.DEEPSEEK_API_KEY = apiKey;
  env.NO_COLOR = '1';
  return env;
}

export function chatHomeFor(runtimeHome: string, chatKey: string): string {
  const digest = createHash('sha256').update(chatKey).digest('hex');
  return path.join(runtimeHome, 'chat', digest, 'home');
}

export function runHomeFor(runDir: string): string {
  return path.join(runDir, 'deepseek', 'home');
}

export async function ensurePrivateDir(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) {
    throw new TypeError('Приватный каталог должен быть абсолютным');
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  return directory;
}

/**
 * Совместимая обёртка старых callers сохраняет явный выбор внешнего CLI.
 * Версию проверяет общий descriptor, поэтому Node не подменяет бинарь Harness.
 */
export async function probeDeepSeekBin(bin: string): Promise<{
  ok: boolean;
  version: string | null;
  error?: string;
}> {
  return probeDeepSeekRuntime({ deepseekBinOverride: bin });
}
