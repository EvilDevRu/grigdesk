import { createHash } from 'node:crypto';
import path from 'node:path';

import { DEEPSEEK_PIN } from '../deepseek/contract.ts';
import {
  probeDeepSeekRuntime,
} from '../deepseek/runtimeProcess.ts';
import { prepareDeepSeekRuntime, preparedDeepSeekRuntime } from '../deepseek/preparedRuntime.ts';
import type { PreparedExecutorRuntime } from '../executorSettings/types.ts';
import type { DeepSeekRuntimeConfig } from '../deepseek/runtimeProcess.ts';
import { selectedDeepSeekBinary } from '../deepseek/distribution.ts';
import type { ExecutorDistributionProbe } from './index.ts';
import {
  deepSeekAuth,
  deepSeekCatalogCacheKey,
  deepSeekSeedModels,
  readDeepSeekCatalog,
} from '../deepseek/catalog.ts';
import { runDeepSeekWebTurn } from '../deepseek/webRuntime.ts';
import { mergeMcpServers, readProjectMcpServers } from '../deepseek/projectMcp.ts';
import { readDeepSeekMcpStatus } from '../deepseek/mcpStatus.ts';
import { deepSeekUsage } from '../deepseek/balance.ts';
import { DEEPSEEK_PROFILE_REVISION } from '../deepseek/profile.ts';
import { RETRY_CONTRACT } from '../chat/retryContract.ts';
import { DSH_TURN_FAILURE_RULES } from '../deepseek/turnFailureRules.ts';
import { directSshSetting } from './_directSshPolicy.ts';
import { deepSeekNativeSettings } from '../executorSettings/deepseek.ts';
import { installedLegacyBuildId } from '../deepseek/legacyCutover.ts';

type DeepSeekConfig = DeepSeekRuntimeConfig & {
  rootDir?: string;
  deepseekBin: string;
  deepseekRuntimeHome: string;
};

const DEEPSEEK_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);

function shellArgument(value: string): string {
  return /^[\w./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Недоступная поставка исправляется явной установкой отдельного ELF.
 * Карточка не предлагает пересборку сервера или восстановление legacy current.
 */
function deepSeekDistributionProblem(config: DeepSeekConfig): { message: string; command: string } {
  const root = config.rootDir && path.isAbsolute(config.rootDir) ? config.rootDir : '';
  const prefix = root ? shellArgument(path.join(root, 'deepseek')) : 'deepseek';

  return {
    message: 'Автономная поставка DeepSeek недоступна или не прошла проверку.',
    command: `npm --prefix ${prefix} run install:binary`,
  };
}

export function deepSeekAuthProfileId(env: NodeJS.ProcessEnv = process.env): string {
  const key = String(env.DEEPSEEK_API_KEY || '');
  const fingerprint = key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : 'missing';
  return `deepseek-env-key:${fingerprint}`;
}

/**
 * У бинарной поставки профиль содержит права и ревизию политики без версии runtime.
 * Legacy identity сохраняется только до явного cutover установленного home.
 */
export function deepSeekSecurityProfile(
  settings: Record<string, unknown> = {},
  runtimeIdentity?: string,
): string {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    ...(runtimeIdentity ? { version: DEEPSEEK_PIN.version, runtimeIdentity } : {}),
    profile: DEEPSEEK_PROFILE_REVISION,
    ssh: settings.blockDirectSsh !== false,
    db: settings.blockDirectDb === true,
    strictDb: settings.strictUnknownDbClient === true,
  })).digest('hex');
  return `${DEEPSEEK_PROFILE_REVISION}:${fingerprint}`;
}

export default {
  id: 'deepseek',
  effortHints: {
    off: 'Рассуждение выключено: быстрые ответы без этапа обдумывания.',
    low: 'Короткое рассуждение для простых задач; быстрее и экономнее.',
    high: 'Глубокое рассуждение для сложного кода и анализа.',
    max: 'Максимальное усилие рассуждения для самых трудных задач.',
  },
  nativeSettings: deepSeekNativeSettings,
  prepareRuntime: prepareDeepSeekRuntime,
  name: 'DeepSeek',
  vendor: 'DeepSeek',
  color: '#4D6BFE',
  order: 4,
  workToolsTransport: 'mcp',
  workdir: { switch: 'reseed', roots: 'single' },
  sessionBinding: {
    /**
     * Только установленный legacy current определяет прежнюю формулу binding.
     * Проверка handle не позволяет использовать профиль от другого подготовленного runtime.
     */
    legacySecurityProfiles: async (
      config: DeepSeekConfig,
      settings: Record<string, unknown> = {},
      preparedRuntime?: PreparedExecutorRuntime,
    ) => {
      await preparedDeepSeekRuntime(config, preparedRuntime);

      const buildId = await installedLegacyBuildId(config);

      return buildId ? [deepSeekSecurityProfile(settings, `deepseek-build:${buildId}`)] : [];
    },
    authProfileId: () => deepSeekAuthProfileId(process.env),
    securityProfile: async (
      config: DeepSeekConfig,
      settings: Record<string, unknown> = {},
      preparedRuntime?: PreparedExecutorRuntime,
    ) => {
      await preparedDeepSeekRuntime(config, preparedRuntime);

      return deepSeekSecurityProfile(settings);
    },
  },
  /**
   * Доставка объявляется адаптером; общий UI не перечисляет провайдеров.
   * Доступность отдельного ELF приходит только из готового async probe.
   */
  distribution(config: DeepSeekConfig, probe?: ExecutorDistributionProbe) {
    const base = {
      kind: 'binary' as const,
      managed: true,
      label: 'Отдельная поставка DeepSeek',
      authHint: 'Задайте ключ кнопкой «Ключи доступа» ниже или DEEPSEEK_API_KEY в .env папки данных.',
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
        problem: deepSeekDistributionProblem(config),
      } : {}),
    };
  },
  // Страница не в формате Statuspage: при сбое счёта остаётся ссылкой, а не разобранным
  // состоянием, — контракт допускает и это.
  statusPage: 'https://status.deepseek.com',
  catalogLive: true,
  retryContract: RETRY_CONTRACT.PRE_PROMPT_ONLY,
  // Виды сбоя хода объявляет сам адаптер: ядро не знает имён вендора. Общие признаки
  // (статусы, слова) добавляет реестр — здесь только коды DSH из turn/end.reason.error.
  turnFailureRules: DSH_TURN_FAILURE_RULES,
  inTurnInput: { protocol: 1, text: true, confirmation: 'forwarded' },
  compaction: { kind: 'summary' },
  directSshPolicy: {
    enforcement: 'command-hook',
    note: 'Команды SSH/БД проверяет server-owned PreToolUse hook; файловая граница — sandbox DSH.',
  },
  settings: [directSshSetting({
    note: 'Запрет обеспечивает server-owned PreToolUse hook внутри штатного профиля DSH.',
  })],
  // Ключ задаётся окном «Ключи доступа»: сервер пишет его в .env папки данных и в process.env.
  credentials: [{
    env: 'DEEPSEEK_API_KEY',
    kind: 'secret',
    label: 'API-ключ DeepSeek',
    hint: 'Ключ из личного кабинета platform.deepseek.com.',
  }],

  bin(config: DeepSeekConfig) {
    return selectedDeepSeekBinary(config);
  },
  probe(config: DeepSeekConfig) {
    return probeDeepSeekRuntime(config);
  },
  auth() { return deepSeekAuth(process.env); },
  // Лимитов подписки у DeepSeek нет — есть предоплаченный счёт. Вместо «CLI не отдаёт
  // лимиты» всплывашка получает остаток по валютам и темп его расхода.
  usage(config: DeepSeekConfig) { return deepSeekUsage({ config, env: process.env }); },

  mcpStatus(config: DeepSeekConfig) {
    return readDeepSeekMcpStatus(config);
  },

  async modes() {
    return [
      {
        id: 'default',
        order: 1,
        label: 'Правки в проекте',
        hint: 'Обычные правки внутри проекта уже разрешены; запрос нужен только для выхода за границу.',
      },
      {
        id: 'auto',
        order: 2,
        label: 'Авто',
        hint: 'Правки внутри проекта уже разрешены; опасное расширение границы решает человек.',
      },
      {
        id: 'read-only',
        order: 3,
        label: 'Только чтение',
        hint: 'Исходники защищены от записи; запросы расширить sandbox автоматически отклоняются.',
      },
    ];
  },

  efforts() { return [...DEEPSEEK_EFFORTS]; },
  modelEfforts(model: { efforts?: unknown } | null, ladder: readonly string[] | null) {
    const allowed = Array.isArray(model?.efforts) ? model.efforts as string[] : DEEPSEEK_EFFORTS;
    return Array.isArray(ladder) ? ladder.filter((value) => allowed.includes(value)) : [...allowed];
  },
  seedModels() { return deepSeekSeedModels(); },
  catalog(config: DeepSeekConfig) {
    if (!process.env.DEEPSEEK_API_KEY) return null;
    return readDeepSeekCatalog({ config, env: process.env }).then((result) => result.models);
  },
  catalogCacheKey(config: DeepSeekConfig) {
    return deepSeekCatalogCacheKey(config, process.env);
  },

  // Проектные и служебные MCP входят в одноразовый overlay web-профиля до старта хода.
  async run(options: Parameters<typeof runDeepSeekWebTurn>[0]) {
    const project = options.cwd ? await readProjectMcpServers(options.cwd) : { file: null, servers: [], warnings: [] };
    for (const warning of project.warnings) {
      options.log?.warn?.({ file: project.file, warning }, 'DeepSeek: запись .mcp.json пропущена');
    }
    const mcpServers = mergeMcpServers(options.mcpServers || [], project.servers);
    const result = await runDeepSeekWebTurn({ ...options, mcpServers });
    if (result.stopReason === 'cancelled') {
      const error = Object.assign(new Error('Ход DeepSeek остановлен.'), {
        stopped: true,
        sessionId: result.sessionId,
        steps: result.steps,
        contextTokens: result.contextTokens,
        contextWindow: result.contextWindow,
        contextMetric: result.contextMetric,
        contextCache: result.contextCache,
      });
      throw error;
    }
    return result;
  },
};
