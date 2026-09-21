import { createHash } from 'node:crypto';

import { DEEPSEEK_PIN } from '../deepseek/contract.ts';
import { probeDeepSeekBin } from '../deepseek/env.ts';
import {
  deepSeekAuth,
  deepSeekCatalogCacheKey,
  deepSeekSeedModels,
  readDeepSeekCatalog,
} from '../deepseek/catalog.ts';
import { runDeepSeekTurn } from '../deepseek/runtime.ts';
import { mergeMcpServers, readProjectMcpServers } from '../deepseek/projectMcp.ts';
import { deepSeekUsage } from '../deepseek/balance.ts';
import { DEEPSEEK_PROFILE_REVISION } from '../deepseek/profile.ts';
import { RETRY_CONTRACT } from '../chat/retryContract.ts';
import { directSshSetting } from './_directSshPolicy.ts';

type DeepSeekConfig = {
  deepseekBin: string;
  deepseekRuntimeHome: string;
};

const DEEPSEEK_EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);

export function deepSeekAuthProfileId(env: NodeJS.ProcessEnv = process.env): string {
  const key = String(env.DEEPSEEK_API_KEY || '');
  const fingerprint = key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : 'missing';
  return `deepseek-env-key:${fingerprint}`;
}

export function deepSeekSecurityProfile(settings: Record<string, unknown> = {}): string {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    version: DEEPSEEK_PIN.version,
    profile: DEEPSEEK_PROFILE_REVISION,
    ssh: settings.blockDirectSsh !== false,
    db: settings.blockDirectDb === true,
    strictDb: settings.strictUnknownDbClient === true,
  })).digest('hex');
  return `${DEEPSEEK_PROFILE_REVISION}:${fingerprint}`;
}

export default {
  id: 'deepseek',
  name: 'DeepSeek',
  vendor: 'DeepSeek',
  color: '#4D6BFE',
  order: 4,
  workToolsTransport: 'mcp',
  sessionBinding: {
    authProfileId: () => deepSeekAuthProfileId(process.env),
    securityProfile: (_config: unknown, settings: Record<string, unknown> = {}) => (
      deepSeekSecurityProfile(settings)
    ),
  },
  install: 'node server/scripts/deepseekHarnessInstall.mts',
  // Страница не в формате Statuspage: при сбое счёта остаётся ссылкой, а не разобранным
  // состоянием, — контракт допускает и это.
  statusPage: 'https://status.deepseek.com',
  catalogLive: true,
  retryContract: RETRY_CONTRACT.PRE_PROMPT_ONLY,
  compaction: { kind: 'summary' },
  directSshPolicy: {
    enforcement: 'command-hook',
    note: 'Команды SSH/БД проверяет server-owned PreToolUse hook; файловая граница — sandbox DSH.',
  },
  settings: [directSshSetting({
    note: 'Запрет обеспечивает server-owned PreToolUse hook внутри штатного профиля DSH.',
  })],

  bin(config: DeepSeekConfig) { return config.deepseekBin; },
  probe(config: DeepSeekConfig) { return probeDeepSeekBin(config.deepseekBin); },
  auth() { return deepSeekAuth(process.env); },
  // Лимитов подписки у DeepSeek нет — есть предоплаченный счёт. Вместо «CLI не отдаёт
  // лимиты» всплывашка получает остаток по валютам и темп его расхода.
  usage(config: DeepSeekConfig) { return deepSeekUsage({ config, env: process.env }); },

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
  modelFamily(model: { family?: unknown } | null | undefined) {
    return String(model?.family || 'default');
  },

  // Проектные MCP из `.mcp.json` доезжают до DSH только через ACP-список сессии:
  // добавляем их к служебным серверам Cockpit на каждом ходу (resume принимает тот же список).
  async run(options: Parameters<typeof runDeepSeekTurn>[0]) {
    const project = options.cwd ? await readProjectMcpServers(options.cwd) : { file: null, servers: [], warnings: [] };
    for (const warning of project.warnings) {
      options.log?.warn?.({ file: project.file, warning }, 'DeepSeek: запись .mcp.json пропущена');
    }
    const mcpServers = mergeMcpServers(options.mcpServers || [], project.servers);
    const result = await runDeepSeekTurn({ ...options, mcpServers });
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
