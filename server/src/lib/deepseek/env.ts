import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { probeDeepSeekRuntime } from './runtimeProcess.ts';

const PASSTHROUGH_ENV = ['PATH', 'HOME', 'GRIGDESK_HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const;

export interface DeepSeekEnvError extends Error {
  code: 'deepseek_api_key_missing';
}

function envError(message: string): DeepSeekEnvError {
  const error = new Error(message) as DeepSeekEnvError;
  error.code = 'deepseek_api_key_missing';
  return error;
}

/**
 * Общий allowlist процесса DSH: системные имена, служебные флаги и явный ключ маршрута.
 * Metadata caller обходится без ключа; остальные credentials и proxy не наследуются.
 */
export function buildHarnessChildEnv({
  source,
  dshHome,
  credential,
}: {
  source: NodeJS.ProcessEnv | Record<string, string | undefined>;
  dshHome: string;
  credential?: { name: string; value: string };
}): Record<string, string> {
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

  if (credential) {
    env[credential.name] = credential.value;
  }

  env.NO_COLOR = '1';

  return env;
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

  return buildHarnessChildEnv({
    source,
    dshHome,
    credential: { name: 'DEEPSEEK_API_KEY', value: apiKey },
  });
}

/**
 * Новая поставка хранит home по chatKey без версии бинарника или generation.
 * Legacy layout остаётся доступен до явного переноса установленной памяти.
 */
export function chatHomeFor(
  runtimeHome: string,
  chatKey: string,
  layout: 'legacy' | 'stable' = 'legacy',
): string {
  const digest = createHash('sha256').update(chatKey).digest('hex');

  if (layout === 'stable') {
    return path.join(runtimeHome, 'chats', digest);
  }

  return path.join(runtimeHome, 'chat', digest, 'home');
}

export function runHomeFor(runDir: string): string {
  return path.join(runDir, 'deepseek', 'home');
}

/**
 * Стабильный home принадлежит одному провайдеру, а не версии runtime.
 * Закрытый marker создаётся без перезаписи чужого файла и проверяется до запуска.
 */
export async function ensureHarnessChatHome(
  directory: string,
  provider: 'deepseek' | 'glm',
): Promise<string> {
  await ensurePrivateDir(directory);

  const marker = path.join(directory, '.grigdesk-runtime.json');

  await fs.writeFile(marker, JSON.stringify({ format: 1, provider }), {
    mode: 0o600,
    flag: 'wx',
  }).catch((error) => {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  });

  const binding = JSON.parse(await fs.readFile(marker, 'utf8'));

  if (binding.format !== 1 || binding.provider !== provider
    || !Object.keys(binding).every((key) => ['format', 'provider'].includes(key))) {
    throw new Error('Каталог памяти DSH имеет другой или несовместимый контракт');
  }

  return directory;
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
