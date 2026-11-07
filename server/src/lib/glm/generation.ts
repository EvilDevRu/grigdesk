import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import { resolveDeepSeekRuntime, resolveDeepSeekRuntimeAsync } from '../deepseek/runtimeProcess.ts';
import type { DeepSeekRuntimeConfig, DeepSeekRuntimeDescriptor } from '../deepseek/runtimeProcess.ts';
import type { DeepSeekArtifactHeader } from '../../../../shared/node/deepSeekArtifact.ts';
import { glmAccessError } from './env.ts';
import type { GlmCompatibilityRuntime, GlmAccessMode } from './contract.ts';
import {
  GLM_ALLOWED_MODES,
  GLM_POLICY_REVISION,
  GLM_PROFILE_REVISION,
  glmCompatibilityIdentity,
} from './contract.ts';
import type { DeepSeekRuntimeInfo } from '../../../../shared/chat/deepSeekBinary.ts';

export interface GlmGeneration {
  buildId: string;
  runtimeVersion: string;
  runtime: GlmCompatibilityRuntime;
  packageId?: string;
  release?: DeepSeekRuntimeInfo['glm'];
}

type PluginContract = GlmCompatibilityRuntime['llmPiAi'];

/**
 * Новая поставка использует выбранный binary descriptor без подмены режима доставки.
 * Legacy GLM продолжает требовать embedded generation и не ищет stock CLI.
 */
export function glmRuntimeConfig(config: DeepSeekRuntimeConfig): DeepSeekRuntimeConfig {
  return config;
}

/**
 * Допуск сверяется с metadata актуального выпуска, а не с прежним результатом probe.
 * Совпадение identity не позволяет обойти серверную политику режимов и ревизий.
 */
export function assertGlmGenerationAdmission(
  generation: GlmGeneration,
  mode: GlmAccessMode,
  override?: readonly { mode: GlmAccessMode; compatibility: string }[],
): string {
  const release = generation.release;

  if (release) {
    if (!GLM_ALLOWED_MODES.includes(mode)) {
      throw glmAccessError('glm_mode_not_admitted', 'Режим GLM не разрешён политикой сервера');
    }
    if (release.profileRevision !== GLM_PROFILE_REVISION || release.policyRevision !== GLM_POLICY_REVISION) {
      throw glmAccessError('glm_runtime_incompatible', 'Профиль или политика GLM несовместимы с сервером');
    }
  }

  const identity = glmCompatibilityIdentity(generation.runtime, mode);
  const admission = override ?? release?.admission ?? [];

  if (!admission.some((entry) => entry.mode === mode && entry.compatibility === identity)) {
    throw glmAccessError('glm_runtime_not_admitted', 'Эта сборка DSH не прошла допуск GLM');
  }

  return identity;
}

/**
 * Поле llmPiAi поколения принимается только целиком: версия и integrity pi-ai,
 * хэш исходников плагина и список патчей. Частичное поле означает «плагина нет».
 */
function pluginContract(value: unknown): PluginContract | null {
  const plugin = recordOrEmpty(value);
  const piAi = recordOrEmpty(plugin.piAi);
  const patches = Array.isArray(plugin.patches) ? plugin.patches.map(recordOrEmpty) : null;

  if (typeof piAi.version !== 'string' || !piAi.version || typeof piAi.integrity !== 'string'
    || !piAi.integrity || typeof plugin.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(plugin.sourceHash)
    || !patches || patches.some((patch) => typeof patch.path !== 'string'
      || typeof patch.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(patch.sha256))) {
    return null;
  }

  return {
    piAi: {
      version: piAi.version,
      integrity: piAi.integrity,
    },
    sourceHash: plugin.sourceHash,
    patches: patches.map((patch) => ({ path: String(patch.path), sha256: String(patch.sha256) })),
  };
}

/**
 * Выбранная встроенная generation DSH глазами GLM: buildId, версия и входы допуска.
 * Внешний DeepSeek, отсутствие поколения и поколение без плагина — разные отказы.
 */
export function describeGlmGeneration(config: DeepSeekRuntimeConfig): GlmGeneration {
  return generationFromBinary(resolveDeepSeekRuntime(config));
}

/**
 * Сервер получает те же входы допуска через async descriptor и проверенный артефакт.
 * Формула compatibility и прежний запрет внешнего runtime остаются без изменений.
 */
export async function describeGlmGenerationAsync(
  config: DeepSeekRuntimeConfig,
  prepared?: DeepSeekRuntimeDescriptor,
): Promise<GlmGeneration> {
  return generationFromBinary(prepared ?? await resolveDeepSeekRuntimeAsync(config));
}

/**
 * Sync CLI и async сервер используют одну проекцию защищённых входов GLM.
 * Отсутствующий плагин сохраняет версии поколения для диагностической карточки.
 */
function generationFromHeader(header: DeepSeekArtifactHeader): GlmGeneration {
  const plugin = pluginContract(header.llmPiAi);

  if (!plugin || !header.commit || !header.composition || !header.dependencyLock) {
    throw Object.assign(glmAccessError('glm_plugin_missing', 'В сборке DSH нет модельного плагина GLM'), {
      buildId: header.buildId,
      runtimeVersion: header.runtimeVersion,
    });
  }

  return {
    buildId: header.buildId,
    runtimeVersion: header.runtimeVersion,
    runtime: {
      source: { commit: header.commit },
      inputIdentity: {
        composition: header.composition,
        dependencyLock: header.dependencyLock,
      },
      llmPiAi: plugin,
    },
  };
}

/**
 * GLM берёт входы допуска только из выбранного совместимого ELF.
 * Никакие paths или файлы прежней generation не участвуют в discovery.
 */
function generationFromBinary(runtime: DeepSeekRuntimeDescriptor): GlmGeneration {
  const metadata = runtime.metadata;

  if (runtime.kind !== 'binary' || !metadata) {
    throw glmAccessError('glm_runtime_missing', 'Описание бинарной поставки DSH недоступно');
  }

  return {
    packageId: metadata.packageId,
    ...generationFromHeader({
      buildId: metadata.buildId,
      runtimeVersion: metadata.runtimeVersion,
      version: metadata.upstreamVersion,
      commit: metadata.glm.inputs.source.commit,
      composition: metadata.glm.inputs.inputIdentity.composition,
      dependencyLock: metadata.glm.inputs.inputIdentity.dependencyLock,
      llmPiAi: metadata.glm.inputs.llmPiAi,
    }),
    release: metadata.glm,
  };
}
