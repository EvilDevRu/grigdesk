import { createHash } from 'node:crypto';

import { canonicalJson } from '../lib/canonicalJson.ts';
import type { DeepSeekHostContract, DeepSeekRuntimeInfo } from '../chat/deepSeekBinary.ts';

export interface GlmCompatibilityRuntime {
  source: {
    commit: string;
  };
  inputIdentity: {
    composition: string;
    dependencyLock: string;
  };
  llmPiAi: {
    piAi: {
      version: string;
      integrity: string;
    };
    sourceHash: string;
    patches: readonly { path: string; sha256: string }[];
  };
}

/**
 * Допуск связывает только прежние входы GLM и явно переданные ревизии профиля.
 * Формула общая для сервера и установщика, путь и версия поставки в неё не входят.
 */
export function glmCompatibilityHash(
  runtime: GlmCompatibilityRuntime,
  mode: 'api' | 'coding-plan',
  revisions: { profile: string; policy: string },
): string {
  const inputs = {
    commit: runtime.source.commit,
    patches: runtime.llmPiAi.patches,
    composition: runtime.inputIdentity.composition,
    dependencyLock: runtime.inputIdentity.dependencyLock,
    piAi: runtime.llmPiAi.piAi,
    pluginSource: runtime.llmPiAi.sourceHash,
    profile: revisions.profile,
    policy: revisions.policy,
    baseURL: mode === 'api'
      ? 'https://api.z.ai/api/paas/v4'
      : 'https://api.z.ai/api/coding/paas/v4',
  };

  return createHash('sha256').update(canonicalJson(inputs)).digest('hex');
}

/**
 * Installer и updater требуют допуск выбранного режима по фактическим входам ELF.
 * Потребитель может заменить режим; ревизии и остальные требования остаются у host.
 */
export function assertDeepSeekGlmApiAdmission(
  info: DeepSeekRuntimeInfo,
  host: DeepSeekHostContract,
  mode: DeepSeekHostContract['glm']['mode'] = host.glm.mode,
): string {
  const plugin = info.glm.inputs.llmPiAi;
  const identity = plugin ? glmCompatibilityHash({ ...info.glm.inputs, llmPiAi: plugin }, mode, {
    profile: host.glm.profileRevision,
    policy: host.glm.policyRevision,
  }) : null;

  if (!identity || !info.glm.admission.some((entry) => entry.mode === mode
    && entry.compatibility === identity)) {
    throw Object.assign(new Error(`Поставка DeepSeek не имеет требуемого допуска GLM (${mode})`), {
      code: 'deepseek_glm_unadmitted',
    });
  }

  return identity;
}
