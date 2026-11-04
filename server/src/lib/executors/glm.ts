import { createHash } from 'node:crypto';
import path from 'node:path';

import { RETRY_CONTRACT } from '../chat/retryContract.ts';
import { probeDeepSeekRuntime, resolveDeepSeekRuntimeAsync } from '../deepseek/runtimeProcess.ts';
import type { DeepSeekRuntimeConfig } from '../deepseek/runtimeProcess.ts';
import { selectedDeepSeekBinary } from '../deepseek/distribution.ts';
import type { ExecutorDistributionProbe, ExecutorProbe } from './index.ts';
import {
  GLM_ALLOWED_MODES,
  GLM_POLICY_REVISION,
  GLM_PROFILE_REVISION,
  buildGlmRoute,
  glmCompatibilityIdentity,
  selectGlmServiceKey,
} from '../glm/contract.ts';
import type { GlmAccessMode } from '../glm/contract.ts';
import { assertGlmRuntimeHome, glmAccessError, glmAuthProfileId, resolveGlmAccess } from '../glm/env.ts';
import { assertGlmGenerationAdmission, describeGlmGenerationAsync } from '../glm/generation.ts';
import { readGlmCatalog } from '../glm/catalog.ts';
import { glmMcpStatus } from '../glm/mcp.ts';
import { runGlmTurn } from '../glm/runtime.ts';
import { runGlmModelOnly } from '../glm/modelOnly.ts';
import { glmUsage } from '../glm/usage.ts';
import { prepareGlmRuntime, preparedGlmRuntime } from '../glm/preparedRuntime.ts';
import type { PreparedExecutorRuntime } from '../executorSettings/types.ts';
import type { GlmRuntimeDeps, GlmTurnOptions } from '../glm/runtime.ts';
import { directSshSetting } from './_directSshPolicy.ts';
import { DSH_TURN_FAILURE_RULES } from '../deepseek/turnFailureRules.ts';
import { readHarnessSkillCommands } from '../deepseek/skillCommands.ts';

type GlmConfig = DeepSeekRuntimeConfig & {
  rootDir?: string;
  glmRuntimeHome?: string;
};

// usageFetch и usageNow подменяют сеть и часы состояния счёта в тестах.
export type GlmAdapterDeps = GlmRuntimeDeps & {
  usageFetch?: typeof fetch;
  usageNow?: () => number;
};

type Problem = { message: string; command?: string };

const AUTH_LABELS: Readonly<Record<string, (mode: GlmAccessMode | null) => string>> = Object.freeze({
  glm_access_mode_missing: () => 'нужен GRIGDESK_GLM_API_MODE (api или coding-plan) в окружении службы',
  glm_access_mode_invalid: () => 'GRIGDESK_GLM_API_MODE: допустимо api или coding-plan',
  glm_key_missing: (mode) => `нужен ${keyName(mode)} в окружении службы`,
  glm_mode_not_admitted: (mode) => `режим ${mode} ещё не допущен: нужны проверка сборки и живой запуск`,
  glm_runtime_home_invalid: () => 'GRIGDESK_GLM_RUNTIME_HOME должен быть абсолютным путём',
});


function keyName(mode: GlmAccessMode | null): string {
  return mode === 'api' ? 'ZAI_API_KEY' : 'ZAI_CODING_API_KEY';
}

function shellArgument(value: string): string {
  return /^[\w./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Карточка направляет к установке совместимого бинарного выпуска.
 * Плагин и допуск проверяются по его metadata без файлов legacy generation.
 */
function problemFor(config: GlmConfig, code: string): Problem {
  const directory = config.rootDir ? path.join(config.rootDir, 'deepseek') : 'deepseek';

  return {
    message: code === 'glm_plugin_missing'
      ? 'В поставке нет модельного плагина GLM (llm-pi-ai); установите совместимый бинарник.'
      : 'Поставка DeepSeek для GLM не прошла проверку.',
    command: `npm --prefix ${shellArgument(directory)} run install:binary`,
  };
}

function keyFingerprint(key: string | null): string {
  return key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : 'missing';
}

/**
 * Карточка GLM (Z.ai): выбранная поставка DSH, режим доступа и ключ из окружения службы.
 * Зависимости передаются явно, поэтому тесты проверяют допуск без правки process.env.
 */
export function createGlmAdapter(deps: GlmAdapterDeps) {
  /**
   * Причина недоступности хода: режим, ключ и допуск, затем корень private homes.
   * Ключ здесь только проверяется на наличие и наружу не выходит.
   */
  const access = (config: GlmConfig) => {
    const resolved = resolveGlmAccess({ env: deps.env, admission: deps.admission });

    if (resolved.reason) {
      return resolved;
    }

    try {
      assertGlmRuntimeHome(String(config.glmRuntimeHome ?? ''));
    } catch {
      return { mode: resolved.mode, reason: 'glm_runtime_home_invalid' as const };
    }

    return resolved;
  };

  // run есть только у допущенного режима из окружения (Р9): иначе карточка setup-only.
  const mode = resolveGlmAccess({ env: deps.env, admission: [] }).mode;

  const admitted = mode !== null && (deps.admission
    ? deps.admission.some((entry) => entry.mode === mode) : GLM_ALLOWED_MODES.includes(mode));

  return {
    // Ввод в активный ход — как у DeepSeek на той же сборке DSH: steer встаёт в следующий шаг
    // того же хода, а хук приёма запроса снова отмечает этот ход, и политика его не обрывает.
    ...(admitted ? {
      untrustedInput: Object.freeze({ text: true, images: false }),
      runUntrusted: (input: Parameters<typeof runGlmModelOnly>[0]) => runGlmModelOnly(input, deps),
      run: (input: GlmTurnOptions) => runGlmTurn(input, deps),
      async scopedWorkspace(config: GlmConfig) {
        const runtime = await preparedGlmRuntime(config);

        return process.platform === 'linux' && runtime.metadata?.capabilities.toolPermissions === true;
      },
      inTurnInput: {
        protocol: 1,
        text: true,
        confirmation: 'forwarded',
      } as const,
    } : {}),
    id: 'glm',
    prepareRuntime: prepareGlmRuntime,
    name: 'GLM (Z.ai)',
    commands: () => readHarnessSkillCommands(),
    vendor: 'Z.ai',
    // Белый, как знак на логотипе Z.ai: тёмный цвет читался как «недоступен».
    color: '#FFFFFF',
    order: 5,
    workToolsTransport: 'mcp',
    workdir: { switch: 'reseed', roots: 'single' },
    sessionBinding: {
      /**
       * Прежний binding содержит только compatibility, режим и прежние флаги прав.
       * Подготовленный runtime и допуск проверяются до принятия этой формулы ядром.
       */
      legacySecurityProfiles: async (
        config: GlmConfig,
        settings: Record<string, unknown> = {},
        preparedRuntime?: PreparedExecutorRuntime,
      ) => {
        const { mode } = resolveGlmAccess({ env: deps.env, admission: deps.admission });

        if (!mode) {
          throw glmAccessError('glm_access_mode_missing', 'Режим доступа GLM не задан.');
        }

        const runtime = await preparedGlmRuntime(config, preparedRuntime);
        const generation = await describeGlmGenerationAsync(config, runtime);
        const identity = assertGlmGenerationAdmission(generation, mode, deps.admission);
        const fingerprint = createHash('sha256').update(JSON.stringify({
          profile: GLM_PROFILE_REVISION,
          identity,
          mode,
          ssh: settings.blockDirectSsh !== false,
          db: settings.blockDirectDb === true,
          strictDb: settings.strictUnknownDbClient === true,
        })).digest('hex');

        return [`${GLM_PROFILE_REVISION}:${fingerprint}`];
      },
      /**
       * Учётная запись привязки — режим и отпечаток ключа; ключ наружу не выходит.
       * Смена ключа или режима начинает новую сессию.
       */
      authProfileId: () => {
        const { mode } = resolveGlmAccess({ env: deps.env, admission: deps.admission });
        const key = mode ? selectGlmServiceKey(mode, deps.env) : null;

        return mode && key ? glmAuthProfileId(mode, key) : 'glm-env-key:missing';
      },
      /**
       * Профиль безопасности — ревизии, режим, endpoint и права без identity сборки.
       * Runtime проверяется для допуска до CAS, но его версия не ротирует память.
       */
      securityProfile: async (
        config: GlmConfig,
        settings: Record<string, unknown> = {},
        preparedRuntime?: PreparedExecutorRuntime,
      ) => {
        const { mode } = resolveGlmAccess({ env: deps.env, admission: deps.admission });

        if (!mode) {
          throw glmAccessError('glm_access_mode_missing', 'Режим доступа GLM не задан.');
        }

        const runtime = await preparedGlmRuntime(config, preparedRuntime);
        const generation = await describeGlmGenerationAsync(config, runtime);

        if (generation.release) {
          assertGlmGenerationAdmission(generation, mode, deps.admission);
        }

        const endpoint = deps.modelEndpoint ?? buildGlmRoute(mode).baseURL ?? 'zai:built-in-coding-plan';
        const fingerprint = createHash('sha256').update(JSON.stringify({
          profile: GLM_PROFILE_REVISION,
          policy: GLM_POLICY_REVISION,
          mode,
          endpoint,
          ssh: settings.blockDirectSsh !== false,
          db: settings.blockDirectDb === true,
          strictDb: settings.strictUnknownDbClient === true,
        })).digest('hex');

        return `${GLM_PROFILE_REVISION}:${fingerprint}`;
      },
    },
    /**
     * Состояние счёта или подписки по выбранному режиму: баланс Обычного API или окна
     * Coding Plan. Режим и ключ читаются из живого окружения: окно ключей меняет их без рестарта.
     */
    usage: (config: GlmConfig) => glmUsage({
      env: deps.env,
      runtimeHome: assertGlmRuntimeHome(String(config.glmRuntimeHome ?? '')),
      ...(deps.usageFetch ? { fetchImpl: deps.usageFetch } : {}),
      ...(deps.usageNow ? { now: deps.usageNow } : {}),
    }),
    catalogLive: false,
    effortHints: {
      off: 'Рассуждение выключено: быстрые ответы без этапа обдумывания.',
      low: 'Короткое рассуждение для простых задач; быстрее и экономнее.',
      high: 'Глубокое рассуждение для сложного кода и анализа.',
      max: 'Максимальное усилие рассуждения для самых трудных задач.',
    },
    retryContract: RETRY_CONTRACT.NEVER,
    // Тот же DSH под другим вендором: коды причин общие, автопродолжение — тоже.
    turnFailureRules: DSH_TURN_FAILURE_RULES,
    compaction: { kind: 'summary' },
    directSshPolicy: {
      enforcement: 'command-hook',
      note: 'Команды SSH/БД проверяет server-owned PreToolUse hook; файловая граница — sandbox DSH.',
    },
    settings: [directSshSetting({
      note: 'Запрет обеспечивает server-owned PreToolUse hook внутри профиля GLM.',
    })],
    // Режим и ключи задаются окном «Ключи доступа»: окно и карточка показывают только ключ
    // выбранного режима, ключ другого режима не подставляется.
    credentials: [
      {
        env: 'GRIGDESK_GLM_API_MODE',
        kind: 'choice',
        label: 'Режим доступа Z.ai',
        options: [
          {
            value: 'api',
            label: 'Обычный API',
            hint: 'Оплата по расходу с баланса Z.ai; карточка показывает остаток счёта.',
          },
          {
            value: 'coding-plan',
            label: 'Coding Plan',
            hint: 'Подписка Z.ai с окнами лимитов на 5 часов и неделю.',
          },
        ],
      },
      {
        env: 'ZAI_API_KEY',
        kind: 'secret',
        label: 'API-ключ',
        hint: 'Кабинет z.ai → API Keys. Ключ целиком, вида «id.secret», около 49 символов.',
        when: { env: 'GRIGDESK_GLM_API_MODE', value: 'api' },
      },
      {
        env: 'ZAI_CODING_API_KEY',
        kind: 'secret',
        label: 'API-ключ Coding Plan',
        hint: 'Ключ аккаунта с подпиской Coding Plan: кабинет z.ai → API Keys.',
        when: { env: 'GRIGDESK_GLM_API_MODE', value: 'coding-plan' },
      },
    ],

    /**
     * Способ доставки определяется конфигурацией, состояние приходит из готового probe.
     * Карточка без probe не проверяет файлы и не объявляет сборку работоспособной.
     */
    distribution(config: GlmConfig, probe?: ExecutorDistributionProbe) {
      const base = {
        kind: 'binary' as const,
        managed: true,
        label: 'Отдельная поставка DeepSeek',
        authHint: 'Задайте режим и ключ кнопкой «Ключи доступа» ниже или GRIGDESK_GLM_API_MODE '
          + 'и ZAI_API_KEY / ZAI_CODING_API_KEY в .env папки данных.',
      };

      if (!probe) {
        return base;
      }

      return {
        ...base,
        ...(probe.buildId ? { buildId: probe.buildId } : {}),
        ...(probe.runtimeVersion ? { runtimeVersion: probe.runtimeVersion } : {}),
        ...(probe.packageId ? { packageId: probe.packageId, binaryVersion: probe.binaryVersion } : {}),
        ...(!probe.ok ? {
          error: probe.code,
          problem: problemFor(config, String(probe.code || '')),
        } : {}),
      };
    },

    /**
     * Путь поставки возвращается из config без проверки executable или generation.
     * Карточка получает доступность только из отдельного async probe.
     */
    bin(config: GlmConfig) {
      return selectedDeepSeekBinary(config);
    },

    /**
     * Probe использует metadata одного закреплённого descriptor и допуск выпуска.
     * Отказ не подменяется проверкой legacy generation или установленного stock CLI.
     */
    async probe(config: GlmConfig) {
      let result: ExecutorProbe = { ok: false, version: null };

      try {
        const runtime = await resolveDeepSeekRuntimeAsync(config);

        result = await probeDeepSeekRuntime(config, runtime);

        const generation = await describeGlmGenerationAsync(config, runtime);
        const { mode } = resolveGlmAccess({ env: deps.env, admission: deps.admission });

        assertGlmGenerationAdmission(generation, mode ?? 'api', deps.admission);

        return result;
      } catch (error) {
        const failure = error as { code?: string; message?: string };

        return {
          ...result,
          ok: false,
          code: failure.code ?? 'glm_runtime_missing',
          error: failure.message ?? 'Поставка DSH для GLM недоступна',
        };
      }
    },

    auth(config: GlmConfig) {
      const { mode, reason } = access(config);

      return {
        mode: 'env',
        label: reason ? AUTH_LABELS[reason]!(mode) : `ключ режима ${mode} в окружении службы`,
        available: reason === null,
        reason,
      };
    },

    mcpStatus(config: GlmConfig) {
      return glmMcpStatus(config);
    },

    async modes() {
      return [
        {
          id: 'default',
          order: 1,
          label: 'Правки в проекте',
          hint: 'Правки внутри проекта уже разрешены; запрос нужен только для выхода за границу.',
        },
        {
          id: 'auto',
          order: 2,
          label: 'Авто',
          hint: 'Правки внутри проекта уже разрешены; MCP и неизвестное решает человек.',
        },
      ];
    },

    seedModels() {
      return [];
    },

    /**
     * Каталог закрыт без допущенного режима, ключа и совпавшей identity: процесс не запускается.
     * Допущенный режим читает каталог настоящим ACP-процессом; кэш и TTL — у реестра ядра.
     */
    async catalog(config: GlmConfig) {
      const { mode, reason } = access(config);

      if (reason || !mode) {
        return null;
      }

      if (deps.catalog) {
        return deps.catalog;
      }

      let identity: string;

      try {
        identity = assertGlmGenerationAdmission(
          await describeGlmGenerationAsync(config), mode, deps.admission,
        );
      } catch {
        return null;
      }

      return readGlmCatalog({
        config,
        env: deps.env,
        identity,
        accessMode: mode,
        spawnProcess: deps.spawn,
        modelEndpoint: deps.modelEndpoint,
        egressGuard: deps.egressGuard,
      });
    },

    /**
     * Ключ кэша каталога: packageId, compatibility, режим и отпечаток ключа без самого ключа.
     * Недоступная сборка даёт свой стабильный код вместо identity.
     */
    async catalogCacheKey(config: GlmConfig) {
      const { mode } = resolveGlmAccess({ env: deps.env, admission: deps.admission });
      let identity: string;
      let packageId: string | undefined;

      try {
        const generation = await describeGlmGenerationAsync(config);

        packageId = generation.packageId;
        identity = mode
          ? glmCompatibilityIdentity(generation.runtime, mode)
          : 'mode-missing';
      } catch (error) {
        identity = String((error as { code?: string }).code || 'glm_runtime_missing');
      }

      const fingerprint = keyFingerprint(mode ? selectGlmServiceKey(mode, deps.env) : null);

      return ['glm', ...(packageId ? [packageId] : []), identity, mode || 'none', fingerprint].join(':');
    },
  };
}

export default createGlmAdapter({ env: process.env });
