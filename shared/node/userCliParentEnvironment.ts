import { isRecord } from '../lib/objects.ts';

export const USER_CLI_PARENT_KEY = 'GRIGDESK_USER_CLI_PARENT_V1';
const MAX_BYTES = 64 * 1024;

export interface UserCliParentEnvironmentV1 {
  version: 1;
  path: string | null;
  npmPrefixLower: string | null;
  npmPrefixUpper: string | null;
}

/**
 * Bootstrap переносит только исходные PATH/prefix, не секреты и не произвольный env.
 * Неверный marker остаётся отказом: повторный launcher не выдаёт изменённую среду за исходную.
 */
export function decodeUserCliParent(raw: unknown): UserCliParentEnvironmentV1 | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(raw);

    if (!isRecord(value) || value.version !== 1 || Object.keys(value).length !== 4
      || !['path', 'npmPrefixLower', 'npmPrefixUpper'].every((key) => value[key] === null
        || typeof value[key] === 'string' && !value[key].includes('\0'))) {
      return null;
    }

    return value as unknown as UserCliParentEnvironmentV1;
  } catch {
    return null;
  }
}

/**
 * Первый launcher фиксирует вход до добавления своих каталогов; следующие сохраняют marker.
 * Функция синхронна и не запускает shell: допустима в раннем графе startDataHome.
 */
export function captureUserCliParent(env: NodeJS.ProcessEnv): string {
  const existing = env[USER_CLI_PARENT_KEY];

  if (existing !== undefined) {
    return decodeUserCliParent(existing) ? existing : 'invalid';
  }

  const encoded = JSON.stringify({
    version: 1,
    path: env.PATH ?? null,
    npmPrefixLower: env.npm_config_prefix ?? null,
    npmPrefixUpper: env.NPM_CONFIG_PREFIX ?? null,
  });

  return decodeUserCliParent(encoded) ? encoded : 'invalid';
}
