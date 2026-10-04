import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEEPSEEK_PIN } from '../deepseek/contract.ts';
import {
  describeDeepSeekRuntime,
  probeDeepSeekRuntime,
  requireDeepSeekRuntimeIdentity,
} from '../deepseek/runtimeProcess.ts';
import type { DeepSeekRuntimeConfig } from '../deepseek/runtimeProcess.ts';
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
import { directSshSetting } from './_directSshPolicy.ts';
import { deepSeekNativeSettings } from '../executorSettings/deepseek.ts';

type DeepSeekConfig = DeepSeekRuntimeConfig & {
  rootDir?: string;
  deepseekBin: string;
  deepseekRuntimeHome: string;
};

const DEEPSEEK_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);

// Что видит человек в карточке при недоступной встроенной сборке и чем это лечится.
// Подготовка пересобирает отсутствующую, повреждённую или чужую по ABI сборку.
const DISTRIBUTION_PROBLEMS: Readonly<Record<string, string>> = Object.freeze({
  deepseek_runtime_missing: 'Сборка DeepSeek ещё не подготовлена.',
  deepseek_runtime_corrupt: 'Файлы сборки DeepSeek повреждены; подготовка соберёт её заново.',
  deepseek_runtime_incompatible: 'Сборка DeepSeek собрана под другую версию Node, чем у службы Cockpit; '
    + 'подготовь её тем же Node, которым запущена служба.',
  deepseek_runtime_changed: 'Сборка DeepSeek сменилась во время проверки; перепроверь карточку.',
});

function shellArgument(value: string): string {
  return /^[\w./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Причина недоступности встроенной сборки и команда исправления для терминала.
 * Незавершённую публикацию лечит только recovery своего job, поэтому команда берёт
 * его id из маркера; нечитаемый маркер требует ручной сверки, а не подготовки.
 */
function deepSeekDistributionProblem(
  config: DeepSeekConfig,
  code: string | undefined,
): { message: string; command?: string } {
  const root = config.rootDir && path.isAbsolute(config.rootDir) ? config.rootDir : '';
  const prepare = `${shellArgument(root ? path.join(root, 'bin/cockpit') : 'bin/cockpit')} deps`;

  if (code === 'deepseek_runtime_publish_pending') {
    const runtimeRoot = config.deepseekGenerationRoot
      || (root ? path.join(root, 'server/runtime/deepseek') : '');
    let jobId = '';

    try {
      const pending = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'publish-pending.json'), 'utf8'));

      jobId = /^[0-9a-f-]{36}$/u.test(pending?.jobId || '') ? pending.jobId : '';
    } catch { /* Нечитаемый маркер: команды recovery нет. */ }

    const script = path.join(root, 'server/scripts/prepareDeepSeekRuntime.mts');

    return jobId ? {
      message: 'Обновление Cockpit не завершило публикацию DeepSeek. Восстанови его и перезапусти Cockpit.',
      command: `node ${shellArgument(script)} --recover-job ${jobId}`,
    } : {
      message: 'Маркер незавершённой публикации DeepSeek не читается: сверь checkout и сборку по журналу '
        + 'обновлений вручную.',
    };
  }

  return {
    message: DISTRIBUTION_PROBLEMS[code || ''] || 'Сборка DeepSeek не прошла проверку версии.',
    command: prepare,
  };
}

export function deepSeekAuthProfileId(env: NodeJS.ProcessEnv = process.env): string {
  const key = String(env.DEEPSEEK_API_KEY || '');
  const fingerprint = key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : 'missing';
  return `deepseek-env-key:${fingerprint}`;
}

/**
 * Привязка сессии включает и host-права, и identity конкретного runtime.
 * Обновление композиции не продолжает разговор под прежним security binding.
 */
export function deepSeekSecurityProfile(
  settings: Record<string, unknown> = {},
  runtimeIdentity?: string,
): string {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    version: DEEPSEEK_PIN.version,
    runtimeIdentity,
    profile: DEEPSEEK_PROFILE_REVISION,
    ssh: settings.blockDirectSsh !== false,
    db: settings.blockDirectDb === true,
    strictDb: settings.strictUnknownDbClient === true,
  })).digest('hex');
  return `${DEEPSEEK_PROFILE_REVISION}:${fingerprint}`;
}

export default {
  id: 'deepseek',
  nativeSettings: deepSeekNativeSettings,
  name: 'DeepSeek',
  vendor: 'DeepSeek',
  color: '#4D6BFE',
  order: 4,
  workToolsTransport: 'mcp',
  workdir: { switch: 'reseed', roots: 'single' },
  sessionBinding: {
    authProfileId: () => deepSeekAuthProfileId(process.env),
    securityProfile: (config: DeepSeekConfig, settings: Record<string, unknown> = {}) => (
      deepSeekSecurityProfile(settings, requireDeepSeekRuntimeIdentity(config))
    ),
  },
  install: 'node server/scripts/deepseekHarnessInstall.mts',
  /**
   * Доставка объявляется адаптером; общий UI не перечисляет провайдеров.
   * Отсутствующий embedded artifact остаётся встроенным с причиной отказа.
   */
  distribution(config: DeepSeekConfig, probe?: { ok: boolean; code?: string }) {
    if (config.deepseekBinOverride
      || (!config.deepseekArtifactDir && config.deepseekRuntimeMode !== 'embedded')) {
      return null;
    }

    const base = {
      kind: 'embedded' as const,
      label: 'Входит в Cockpit',
      authHint: 'Добавьте DEEPSEEK_API_KEY в окружение службы Cockpit.',
    };

    try {
      const runtime = describeDeepSeekRuntime(config);
      const described = {
        ...base,
        buildId: runtime.buildId!,
        runtimeVersion: runtime.runtimeVersion,
      };

      // Выбор поколения прошёл, но полную проверку и запуск `-V` выполняет только probe.
      return !probe || probe.ok
        ? described
        : { ...described, problem: deepSeekDistributionProblem(config, probe.code) };
    } catch (error) {
      const code = String((error as { code?: string }).code || 'deepseek_runtime_missing');

      return {
        ...base,
        error: code,
        problem: deepSeekDistributionProblem(config, code),
      };
    }
  },
  // Страница не в формате Statuspage: при сбое счёта остаётся ссылкой, а не разобранным
  // состоянием, — контракт допускает и это.
  statusPage: 'https://status.deepseek.com',
  catalogLive: true,
  retryContract: RETRY_CONTRACT.PRE_PROMPT_ONLY,
  inTurnInput: { protocol: 1, text: true, confirmation: 'forwarded' },
  compaction: { kind: 'summary' },
  directSshPolicy: {
    enforcement: 'command-hook',
    note: 'Команды SSH/БД проверяет server-owned PreToolUse hook; файловая граница — sandbox DSH.',
  },
  settings: [directSshSetting({
    note: 'Запрет обеспечивает server-owned PreToolUse hook внутри штатного профиля DSH.',
  })],

  bin(config: DeepSeekConfig) { return config.deepseekBin; },
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
