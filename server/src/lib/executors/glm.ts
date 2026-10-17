import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { RETRY_CONTRACT } from '../chat/retryContract.ts';
import { probeDeepSeekRuntime, resolveDeepSeekRuntimeAsync } from '../deepseek/runtimeProcess.ts';
import type { DeepSeekRuntimeConfig } from '../deepseek/runtimeProcess.ts';
import {
  GLM_ADMISSION,
  GLM_PROFILE_REVISION,
  glmCompatibilityIdentity,
  selectGlmServiceKey,
} from '../glm/contract.ts';
import type { GlmAccessMode } from '../glm/contract.ts';
import { assertGlmRuntimeHome, glmAccessError, glmAuthProfileId, resolveGlmAccess } from '../glm/env.ts';
import { describeGlmGeneration } from '../glm/generation.ts';
import { readGlmCatalog } from '../glm/catalog.ts';
import { glmMcpStatus } from '../glm/mcp.ts';
import { runGlmTurn } from '../glm/runtime.ts';
import { glmUsage } from '../glm/usage.ts';
import type { GlmRuntimeDeps, GlmTurnOptions } from '../glm/runtime.ts';
import { directSshSetting } from './_directSshPolicy.ts';
import { DSH_TURN_FAILURE_RULES } from '../deepseek/turnFailureRules.ts';

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

const EXTERNAL_MESSAGE = 'GLM работает только на встроенной сборке Cockpit; '
  + 'внешний DeepSeek не используется.';

// Что видит человек при недоступной сборке DSH и чем это лечится. Коды DeepSeek-проверки
// поколения переводятся в ту же подсказку: GLM живёт на той же встроенной сборке.
const RUNTIME_PROBLEMS: Readonly<Record<string, string>> = Object.freeze({
  glm_runtime_missing: 'Встроенная сборка DSH ещё не подготовлена.',
  glm_plugin_missing: 'В сборке DSH нет модельного плагина GLM (llm-pi-ai); подготовь сборку заново.',
  deepseek_runtime_corrupt: 'Файлы встроенной сборки DSH повреждены; подготовка соберёт её заново.',
  deepseek_runtime_incompatible: 'Сборка DSH собрана под другую версию Node, чем у службы Cockpit.',
  deepseek_runtime_changed: 'Сборка DSH сменилась во время проверки; перепроверь карточку.',
});

const AUTH_LABELS: Readonly<Record<string, (mode: GlmAccessMode | null) => string>> = Object.freeze({
  glm_access_mode_missing: () => 'нужен COCKPIT_GLM_API_MODE (api или coding-plan) в окружении службы',
  glm_access_mode_invalid: () => 'COCKPIT_GLM_API_MODE: допустимо api или coding-plan',
  glm_key_missing: (mode) => `нужен ${keyName(mode)} в окружении службы`,
  glm_mode_not_admitted: (mode) => `режим ${mode} ещё не допущен: нужны проверка сборки и живой запуск`,
  glm_runtime_home_invalid: () => 'COCKPIT_GLM_RUNTIME_HOME должен быть абсолютным путём',
});


function keyName(mode: GlmAccessMode | null): string {
  return mode === 'api' ? 'ZAI_API_KEY' : 'ZAI_CODING_API_KEY';
}

function shellArgument(value: string): string {
  return /^[\w./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Подсказка и команда исправления для карточки; внешний DeepSeek лечится только конфигом.
 * Остальные отказы лечит общая подготовка зависимостей Cockpit.
 */
function problemFor(config: GlmConfig, code: string): Problem {
  if (code === 'glm_runtime_external') {
    return { message: `${EXTERNAL_MESSAGE} Убери COCKPIT_DEEPSEEK_BIN из окружения службы.` };
  }

  const root = config.rootDir && path.isAbsolute(config.rootDir) ? config.rootDir : '';

  return {
    message: RUNTIME_PROBLEMS[code] || 'Сборка DSH не прошла проверку версии.',
    command: `${shellArgument(root ? path.join(root, 'bin/cockpit') : 'bin/cockpit')} deps`,
  };
}

function keyFingerprint(key: string | null): string {
  return key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : 'missing';
}

/**
 * Карточка GLM (Z.ai): встроенная generation DSH, режим доступа и ключ из окружения службы.
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
  const admitted = Boolean(mode) && deps.admission.some((entry) => entry.mode === mode);

  return {
    // Ввод в активный ход — как у DeepSeek на той же сборке DSH: steer встаёт в следующий шаг
    // того же хода, а хук приёма запроса снова отмечает этот ход, и политика его не обрывает.
    ...(admitted ? {
      run: (input: GlmTurnOptions) => runGlmTurn(input, deps),
      inTurnInput: {
        protocol: 1,
        text: true,
        confirmation: 'forwarded',
      } as const,
    } : {}),
    id: 'glm',
    name: 'GLM (Z.ai)',
    vendor: 'Z.ai',
    // Белый, как знак на логотипе Z.ai: тёмный цвет читался как «недоступен».
    color: '#FFFFFF',
    order: 5,
    workToolsTransport: 'mcp',
    workdir: { switch: 'reseed', roots: 'single' },
    sessionBinding: {
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
       * Профиль безопасности — ревизия профиля, identity сборки, режим и флаги SSH/БД.
       * Недоступная сборка — отказ с кодом glm_*, который чат показывает человеку.
       */
      securityProfile: (config: GlmConfig, settings: Record<string, unknown> = {}) => {
        const { mode } = resolveGlmAccess({ env: deps.env, admission: deps.admission });

        if (!mode) {
          throw glmAccessError('glm_access_mode_missing', 'Режим доступа GLM не задан.');
        }

        const identity = glmCompatibilityIdentity(describeGlmGeneration(config).runtime, mode);
        const fingerprint = createHash('sha256').update(JSON.stringify({
          profile: GLM_PROFILE_REVISION,
          identity,
          mode,
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
        env: 'COCKPIT_GLM_API_MODE',
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
        when: { env: 'COCKPIT_GLM_API_MODE', value: 'api' },
      },
      {
        env: 'ZAI_CODING_API_KEY',
        kind: 'secret',
        label: 'API-ключ Coding Plan',
        hint: 'Ключ аккаунта с подпиской Coding Plan: кабинет z.ai → API Keys.',
        when: { env: 'COCKPIT_GLM_API_MODE', value: 'coding-plan' },
      },
    ],

    /**
     * Доставка — только встроенная generation; внешний override DeepSeek для GLM — отказ.
     * Поколение без модельного плагина видно с buildId, чтобы было ясно, какую сборку чинить.
     */
    distribution(config: GlmConfig, probe?: { ok: boolean; code?: string }) {
      const base = {
        kind: 'embedded' as const,
        label: 'Входит в Cockpit',
        authHint: 'Задайте режим и ключ кнопкой «Ключи доступа» ниже или COCKPIT_GLM_API_MODE '
          + 'и ZAI_API_KEY / ZAI_CODING_API_KEY в .env папки данных.',
      };

      try {
        const generation = describeGlmGeneration(config);
        const described = {
          ...base,
          buildId: generation.buildId,
          runtimeVersion: generation.runtimeVersion,
        };

        return !probe || probe.ok
          ? described
          : { ...described, problem: problemFor(config, String(probe.code || '')) };
      } catch (error) {
        const failure = error as {
          code?: string;
          buildId?: string;
          runtimeVersion?: string;
        };
        const code = String(failure.code || 'glm_runtime_missing');

        return {
          ...base,
          ...(failure.buildId ? { buildId: failure.buildId, runtimeVersion: failure.runtimeVersion } : {}),
          error: code,
          problem: problemFor(config, code),
        };
      }
    },

    bin(config: GlmConfig) {
      return config.deepseekArtifactDir
        || (config.deepseekGenerationRoot ? path.join(config.deepseekGenerationRoot, 'current') : '');
    },

    /**
     * Общий probe встроенной сборки и проверка closure GLM: поле плагина, его код и pi-ai
     * той версии, что записана в runtime.json проверенного поколения.
     */
    async probe(config: GlmConfig) {
      if (config.deepseekBinOverride) {
        return {
          ok: false,
          version: null,
          code: 'glm_runtime_external',
          error: EXTERNAL_MESSAGE,
        };
      }

      const embedded = { ...config, deepseekRuntimeMode: 'embedded' as const };
      const result = await probeDeepSeekRuntime(embedded);

      if (!result.ok) {
        return result;
      }

      try {
        const generation = describeGlmGeneration(embedded);
        const runtime = await resolveDeepSeekRuntimeAsync(embedded);
        const root = String(runtime.generationDir || '');
        const piAi = JSON.parse(await fs.readFile(
          path.join(root, 'node_modules/@earendil-works/pi-ai/package.json'), 'utf8',
        ));

        await fs.access(path.join(root, 'packages/llm/llm-pi-ai/lib/index.js'));

        if (piAi.version !== generation.runtime.llmPiAi.piAi.version) {
          throw new Error('pi-ai');
        }

        return result;
      } catch {
        return {
          ok: false,
          version: result.version,
          code: 'glm_plugin_missing',
          error: RUNTIME_PROBLEMS.glm_plugin_missing,
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
        identity = glmCompatibilityIdentity(describeGlmGeneration(config).runtime, mode);
      } catch {
        return null;
      }

      if (!deps.admission.some((entry) => entry.mode === mode && entry.compatibility === identity)) {
        return null;
      }

      return readGlmCatalog({
        config,
        env: deps.env,
        identity,
        accessMode: mode,
        spawnProcess: deps.spawn,
      });
    },

    /**
     * Ключ кэша каталога: identity сборки, режим и отпечаток ключа без самого ключа.
     * Недоступная сборка даёт свой стабильный код вместо identity.
     */
    catalogCacheKey(config: GlmConfig) {
      const { mode } = resolveGlmAccess({ env: deps.env, admission: deps.admission });
      let identity: string;

      try {
        identity = mode
          ? glmCompatibilityIdentity(describeGlmGeneration(config).runtime, mode)
          : 'mode-missing';
      } catch (error) {
        identity = String((error as { code?: string }).code || 'glm_runtime_missing');
      }

      const fingerprint = keyFingerprint(mode ? selectGlmServiceKey(mode, deps.env) : null);

      return ['glm', identity, mode || 'none', fingerprint].join(':');
    },
  };
}

export default createGlmAdapter({ env: process.env, admission: GLM_ADMISSION });
