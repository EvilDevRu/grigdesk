// Подготовка web-профиля сохраняет те же границы записи, hooks, env allowlist и
// привязку сессии, которые ACP runtime применял до смены транспорта.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  InTurnAssistantEvent,
  InTurnPort,
  InTurnUnavailableReason,
} from '../../../../shared/chat/chatInTurnContracts.ts';
import type { ChatRunMetadata } from '../../../../shared/chat/chatRun.ts';
import { contextCacheStatus } from '../chat/contextCache.ts';
import { buildDeepSeekChildEnv } from './env.ts';
import { nearestProjectRoot, prepareDeepSeekLaunch, validateMcpServers } from './runtime.ts';
import type { runDeepSeekTurn } from './runtime.ts';
import { runDeepSeekServerTurn } from './serverTurn.ts';
import type { DeepSeekServerProcess, StartDeepSeekServerOptions } from './serverRuntime.ts';
import { assertDeepSeekPreparedRuntime, verifyDeepSeekRuntimeDescriptorAsync } from './runtimeProcess.ts';
import {
  preparedDeepSeekRuntime,
  requireDeepSeekToolPermissions,
  requireDeepSeekToolPolicy,
} from './preparedRuntime.ts';
import { deepSeekWorkActions, normalizeDeepSeekPermissionMode } from './toolPermissionPolicy.ts';
import { createDeepSeekToolPermissionObserver } from './toolPermissionContext.ts';
import type { PreparedExecutorRuntime } from '../executorSettings/types.ts';
import { inspectSessionJournal } from './journal.ts';
import { deepSeekRuntimeError } from './runtimeArtifact.ts';
import type { ChatStep } from '../chat/streamSteps.ts';

type BaseOptions = Parameters<typeof runDeepSeekTurn>[0];
type WebOptions = BaseOptions & {
  preparedRuntime?: PreparedExecutorRuntime;
  onInTurnReady?: (port: InTurnPort) => void;
  onInTurnAvailability?: (status: { available: boolean; reason?: InTurnUnavailableReason }) => void;
  onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
  onRunMetadata?: (metadata: ChatRunMetadata) => void;
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
  const mcpServers = validateMcpServers(options.mcpServers || []).filter((server) => (
    options.factory || options.permissionMode !== 'read-only' || server.name === 'grigdesk-work'
  ));
  const runtime = await preparedDeepSeekRuntime(options.config, options.preparedRuntime);
  const selectedMode = normalizeDeepSeekPermissionMode(options.permissionMode);

  if (!options.factory) {
    requireDeepSeekToolPermissions(runtime);

    if (!selectedMode.ok) {
      throw new TypeError(selectedMode.message);
    }
  }

  assertDeepSeekPreparedRuntime(runtime, options.nativeSettings);
  await verifyDeepSeekRuntimeDescriptorAsync(runtime);

  const launch = await prepareDeepSeekLaunch({
    config: options.config, cwd, workspaceRoot: cwd, chatKey: options.chatKey,
    mode, approval: options.factory ? 'never' : 'ask', projectRoot,
    providerSettings: options.providerSettings,
    nativeSettings: options.nativeSettings,
    transport: 'web', mcpServers,
    ...(!options.factory && selectedMode.ok ? {
      toolPermissions: { mode: selectedMode.mode, workActions: deepSeekWorkActions(options.workTools) },
    } : {}),
    runtime,
  });
  let cleanupFailed = false;

  try {
    if (!options.factory) {
      requireDeepSeekToolPolicy(launch.toolPolicyPath);
    }

    let sessionId = options.sessionId;
    let journalNote: ChatStep | undefined;

    if (runtime.kind === 'binary' && sessionId) {
      const journal = await inspectSessionJournal(
        launch.dshHome, cwd, sessionId, runtime.metadata!.journal.read,
      );

      if (journal.state === 'missing') {
        throw deepSeekRuntimeError(
          'deepseek_session_missing', 'Журнал сессии DeepSeek не найден; сбрось память чата.',
        );
      }
      if (journal.state === 'incompatible') {
        sessionId = null;
        journalNote = {
          k: 'note',
          text: 'Память исполнителя начата заново: формат журнала несовместим.',
          at: Date.now(),
        };
        options.onStep?.(journalNote);
      }
    }

    const env = buildDeepSeekChildEnv({ source: options.env || process.env, dshHome: launch.dshHome });
    const tools = (options.workTools as { descriptors?: Array<{ name?: unknown; function?: { name?: unknown } }> } | null)?.descriptors;
    const workToolNames = new Set((Array.isArray(tools) ? tools : [])
      .map((entry) => String(entry?.name || entry?.function?.name || '')).filter(Boolean));
    const result = await runDeepSeekServerTurn({
      runtime,
      bin: options.config.deepseekBin,
      overlayPath: launch.overlayPath,
      toolPolicyPath: launch.toolPolicyPath,
      ...(launch.toolPolicyPath && selectedMode.ok ? {
        createObserver: ({ sessionId: rootSessionId }) => createDeepSeekToolPermissionObserver(
          rootSessionId, selectedMode.mode,
        ),
      } : {}),
      cwd,
      env,
      nativeSettings: options.nativeSettings,
      message: String(options.message || ''),
      sessionId,
      model: options.model,
      effort: options.effort,
      signal: options.signal,
      onStep: options.onStep,
      onProgress: options.onProgress,
      onRunMetadata: options.onRunMetadata,
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
      ...(journalNote ? {
        reply: `${journalNote.text}\n\n${result.reply || ''}`,
        steps: [journalNote, ...(result.steps || [])],
      } : {}),
      contextCache: contextCacheStatus('unavailable'),
      retryState: 'post_prompt',
    };
  } catch (error) {
    cleanupFailed = (error as { code?: unknown }).code === 'deepseek_binary_cleanup';

    throw error;
  } finally {
    if (!cleanupFailed) {
      await fs.rm(launch.launchDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
