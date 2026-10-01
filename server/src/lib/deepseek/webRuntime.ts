// Подготовка web-профиля сохраняет те же границы записи, hooks, env allowlist и
// привязку сессии, которые ACP runtime применял до смены транспорта.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { InTurnAssistantEvent, InTurnPort, InTurnUnavailableReason } from '../../../../shared/chatInTurnContracts.ts';
import { contextCacheStatus } from '../chat/contextCache.ts';
import { buildDeepSeekChildEnv } from './env.ts';
import { nearestProjectRoot, prepareDeepSeekLaunch, validateMcpServers } from './runtime.ts';
import type { runDeepSeekTurn } from './runtime.ts';
import { runDeepSeekServerTurn } from './serverTurn.ts';
import type { DeepSeekServerProcess, StartDeepSeekServerOptions } from './serverRuntime.ts';

type BaseOptions = Parameters<typeof runDeepSeekTurn>[0];
type WebOptions = BaseOptions & {
  onInTurnReady?: (port: InTurnPort) => void;
  onInTurnAvailability?: (status: { available: boolean; reason?: InTurnUnavailableReason }) => void;
  onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
  startServer?: (options: StartDeepSeekServerOptions) => Promise<DeepSeekServerProcess>;
};

export async function runDeepSeekWebTurn(options: WebOptions) {
  if (!options.cwd || !path.isAbsolute(options.cwd)) {
    throw new TypeError('DeepSeek cwd должен быть абсолютным');
  }
  if (!options.chatKey) throw new Error('DeepSeek runtime требует server-owned chatKey');
  const cwd = await fs.realpath(options.cwd);
  const projectRoot = options.projectRoot
    ? await fs.realpath(options.projectRoot) : await nearestProjectRoot(cwd);
  const mode = options.permissionMode === 'read-only' ? 'read-only' : 'workspace-write';
  const mcpServers = validateMcpServers(options.mcpServers || []);
  const launch = await prepareDeepSeekLaunch({
    config: options.config, cwd, workspaceRoot: cwd, chatKey: options.chatKey,
    mode, approval: options.factory ? 'never' : 'ask', projectRoot,
    providerSettings: options.providerSettings,
    nativeSettings: options.nativeSettings,
    transport: 'web', mcpServers,
  });
  try {
    const env = buildDeepSeekChildEnv({ source: options.env || process.env, dshHome: launch.dshHome });
    const tools = (options.workTools as { descriptors?: Array<{ name?: unknown; function?: { name?: unknown } }> } | null)?.descriptors;
    const workToolNames = new Set((Array.isArray(tools) ? tools : [])
      .map((entry) => String(entry?.name || entry?.function?.name || '')).filter(Boolean));
    const result = await runDeepSeekServerTurn({
      bin: options.config.deepseekBin,
      overlayPath: launch.overlayPath,
      cwd,
      env,
      nativeSettings: options.nativeSettings,
      message: String(options.message || ''),
      sessionId: options.sessionId,
      model: options.model,
      effort: options.effort,
      signal: options.signal,
      onStep: options.onStep,
      onProgress: options.onProgress,
      onSessionCreated: options.onSessionCreated
        ? async (id) => { await options.onSessionCreated?.(id); } : undefined,
      onInTurnReady: options.onInTurnReady,
      onInTurnAvailability: options.onInTurnAvailability,
      onAssistantMessage: options.onAssistantMessage,
      onPermission: options.onPermission
        ? async (presentation) => {
          const answer = await options.onPermission?.(presentation);
          return {
            allow: answer?.allow === true,
            rawAnswers: (answer as { rawAnswers?: Array<{ selected?: string[]; text?: string }> } | null)?.rawAnswers,
          };
        } : undefined,
      permissionMode: options.permissionMode,
      factory: options.factory,
      workToolNames,
      startServer: options.startServer,
    });
    return {
      ...result,
      contextTokens: undefined as number | undefined,
      contextWindow: undefined as number | undefined,
      contextMetric: 'unavailable',
      contextCache: contextCacheStatus('unavailable'),
      retryState: 'post_prompt',
    };
  } finally {
    await fs.rm(launch.launchDir, { recursive: true, force: true }).catch(() => {});
  }
}
