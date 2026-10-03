import { createHash } from 'node:crypto';
import path from 'node:path';

import { buildHarnessChildEnv } from '../deepseek/env.ts';
import { parseGlmAccessMode, selectGlmServiceKey } from './contract.ts';
import type { GlmAccessMode } from './contract.ts';

export type GlmAccessReason =
  | 'glm_access_mode_missing'
  | 'glm_access_mode_invalid'
  | 'glm_key_missing'
  | 'glm_mode_not_admitted';

export interface GlmAccess {
  mode: GlmAccessMode | null;
  reason: GlmAccessReason | null;
}

type GlmEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export const GLM_ROUTE_KEY_ENV = 'COCKPIT_GLM_ROUTE_KEY';

/**
 * Ошибка доступа несёт только публичный код: ни ключа, ни значения окружения в ней нет.
 * Код совпадает с причиной карточки, поэтому ход и карточка говорят одно и то же.
 */
export function glmAccessError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Режим доступа выбирает человек; ключ берётся только из переменной этого режима.
 * Допуск проверяется по списку режимов, identity сборки сверяет ход перед запуском.
 */
export function resolveGlmAccess({
  env,
  admission,
}: {
  env: GlmEnv;
  admission: readonly { mode: GlmAccessMode; compatibility: string }[];
}): GlmAccess {
  const raw = env.COCKPIT_GLM_API_MODE;

  if (raw === undefined || raw === '') {
    return { mode: null, reason: 'glm_access_mode_missing' };
  }

  const mode = parseGlmAccessMode(raw);

  if (!mode) {
    return { mode: null, reason: 'glm_access_mode_invalid' };
  }

  if (!selectGlmServiceKey(mode, env)) {
    return { mode, reason: 'glm_key_missing' };
  }

  if (!admission.some((entry) => entry.mode === mode)) {
    return { mode, reason: 'glm_mode_not_admitted' };
  }

  return { mode, reason: null };
}

/**
 * Окружение процесса GLM: общий allowlist DSH и ключ режима под служебным именем.
 * Ключ другого режима, DEEPSEEK_API_KEY и прочие модельные ключи не подставляются.
 */
export function buildGlmChildEnv({
  source,
  dshHome,
  mode,
}: {
  source: GlmEnv;
  dshHome: string;
  mode: GlmAccessMode;
}): Record<string, string> {
  const key = selectGlmServiceKey(mode, source);

  if (!key) {
    throw glmAccessError('glm_key_missing', 'Для GLM нужен ключ выбранного режима в окружении службы');
  }

  return buildHarnessChildEnv({
    source,
    dshHome,
    credential: { name: GLM_ROUTE_KEY_ENV, value: key },
  });
}

/**
 * Корень homes GLM — только абсолютный путь без NUL; иначе homes зависели бы от cwd службы.
 * Значение по умолчанию вычисляет config внутри stateDir.
 */
export function assertGlmRuntimeHome(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw glmAccessError('glm_runtime_home_invalid', 'COCKPIT_GLM_RUNTIME_HOME должен быть абсолютным путём');
  }

  return value;
}

/**
 * Отпечаток учётной записи для binding: режим и хэш ключа, сам ключ не выходит наружу.
 * Смена ключа или режима даёт новый отпечаток и тем самым новую сессию.
 */
export function glmAuthProfileId(mode: GlmAccessMode, key: string): string {
  const fingerprint = createHash('sha256').update(`${mode}\0${key}`).digest('hex').slice(0, 16);

  return `glm-env-key:${fingerprint}`;
}
