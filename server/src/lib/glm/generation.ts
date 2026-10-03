import { readSelectedDeepSeekHeader } from '../deepseek/runtimeProcess.ts';
import type { DeepSeekRuntimeConfig } from '../deepseek/runtimeProcess.ts';
import { glmAccessError } from './env.ts';
import type { GlmCompatibilityRuntime } from './contract.ts';

export interface GlmGeneration {
  buildId: string;
  runtimeVersion: string;
  runtime: GlmCompatibilityRuntime;
}

type PluginContract = GlmCompatibilityRuntime['llmPiAi'];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Поле llmPiAi поколения принимается только целиком: версия и integrity pi-ai,
 * хэш исходников плагина и список патчей. Частичное поле означает «плагина нет».
 */
function pluginContract(value: unknown): PluginContract | null {
  const plugin = record(value);
  const piAi = record(plugin.piAi);
  const patches = Array.isArray(plugin.patches) ? plugin.patches.map(record) : null;

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
  if (config.deepseekBinOverride) {
    throw glmAccessError('glm_runtime_external', 'GLM работает только на встроенной сборке Cockpit');
  }

  let header: ReturnType<typeof readSelectedDeepSeekHeader>;

  try {
    header = readSelectedDeepSeekHeader({ ...config, deepseekRuntimeMode: 'embedded' });
  } catch (error) {
    throw Object.assign(glmAccessError('glm_runtime_missing', 'Встроенная сборка DSH недоступна'), {
      runtimeCode: String((error as { code?: unknown }).code || ''),
    });
  }

  if (!header) {
    throw glmAccessError('glm_runtime_external', 'GLM работает только на встроенной сборке Cockpit');
  }

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
