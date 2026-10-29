import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { createScopedWorkspaceTools } from './scopedWorkspace.ts';
import { createWorkIpc } from './workIpc.ts';
import type { WorkToolsPort } from './workIpc.ts';
import { runDeepSeekServerTurn } from '../deepseek/serverTurn.ts';
import type { DeepSeekServerTurnOptions } from '../deepseek/serverTurn.ts';
import { startDeepSeekServer } from '../deepseek/serverRuntime.ts';
import type { DeepSeekRuntimeDescriptor } from '../deepseek/runtimeProcess.ts';
import { glmMcpToolName } from '../glm/policy.ts';

// Модуль загружается самим Harness из одноразового server-owned overlay.
// В нём нет зависимостей от исходников GrigDesk или приватных пакетов распакованной поставки.
const GUARD_SOURCE = `import { writeFile } from 'node:fs/promises';
export const name = 'grigdesk-triage-guard';
export const inject = ['tools'];
export async function apply(ctx, config) {
  const allowed = new Set(config.allowed);
  ctx.tools.guard((exec) => allowed.has(exec.name)
    ? undefined : 'Триаж разрешает только собственные файловые инструменты');
  await writeFile(config.proofPath, JSON.stringify({ nonce: config.nonce, allowed: config.allowed }),
    { mode: 0o600, flag: 'wx' });
}
`;

export type ScopedDshOptions = Pick<DeepSeekServerTurnOptions,
  'cwd' | 'message' | 'model' | 'effort' | 'signal' | 'onStep' | 'onProgress' | 'onRunMetadata'> & {
  workspaceAccess: unknown;
  workTools?: WorkToolsPort | null;
};

interface ScopedDshRoute {
  runtime: DeepSeekRuntimeDescriptor;
  childEnv: (home: string) => NodeJS.ProcessEnv;
  rows?: Array<Record<string, unknown>>;
  insert?: Array<Record<string, unknown>>;
  startServer?: typeof startDeepSeekServer;
}

/**
 * Профиль содержит только собственный MCP; отдельный native guard запрещает любой обход по имени.
 * Случайный proof подтверждает регистрацию guard до создания сессии и отправки постановки.
 */
export async function runScopedDsh(options: ScopedDshOptions, route: ScopedDshRoute) {
  options.signal?.throwIfAborted();

  if (!options.model) {
    throw new Error('Триаж требует явный выбор модели.');
  }

  const tools = await createScopedWorkspaceTools(options.workspaceAccess, options.workTools, options.signal);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-triage-dsh-'));
  let ipc: Awaited<ReturnType<typeof createWorkIpc>> | undefined;

  try {
    ipc = await createWorkIpc({ workTools: tools, root: directory });

    const home = path.join(directory, 'home');
    const presetRoot = path.join(directory, 'presets');
    const preset = path.join(presetRoot, 'grigdesk-triage');
    const proofPath = path.join(directory, 'guard-proof.json');
    const guardPath = path.join(directory, 'guard.mjs');
    const overlayPath = path.join(directory, 'overlay.json');
    const nonce = randomUUID();
    const allowed = tools.descriptors.map((tool) => glmMcpToolName('grigdesk-work', tool.name));

    await Promise.all([fs.mkdir(home), fs.mkdir(preset, { recursive: true })]);
    await Promise.all([
      fs.writeFile(path.join(preset, 'agent.cordis.yml'), '[]\n', { mode: 0o600 }),
      fs.writeFile(guardPath, GUARD_SOURCE, { mode: 0o600 }),
      fs.writeFile(overlayPath, JSON.stringify([
        { id: 'agent-presets', config: {
          default: 'grigdesk-triage',
          includeShippedRoot: false,
          includeUserRoot: false,
          roots: [{ path: presetRoot, trust: 'system' }],
        } },
        { id: 'session-title-llm', disabled: true },
        { id: 'agent-instructions', disabled: true },
        { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: options.cwd } },
        { id: 'approval', config: { policy: 'never' } },
        { id: 'permission', config: {
          defaultPreset: 'grigdesk-triage',
          presets: { 'grigdesk-triage': { sandbox: 'read-only', approval: 'never' } },
        } },
        ...(route.rows ?? []),
        { insert: [
          ...(route.insert ?? []),
          {
            id: 'grigdesk-triage-guard',
            name: pathToFileURL(guardPath).href,
            config: {
              proofPath,
              nonce,
              allowed,
            },
          },
          {
            id: 'grigdesk-triage-mcp',
            name: '@deepseek-ai/dsh-mcp-client',
            config: {
              serverName: 'grigdesk-work',
              transport: 'stdio',
              command: ipc.mcpServer.command,
              args: ipc.mcpServer.args,
              env: {},
              failOnStartupError: true,
              reconnect: { enabled: false },
            },
          },
        ] },
      ]), { mode: 0o600 }),
    ]);

    /**
     * Ни один prompt не доходит до runtime до подтверждения собственного native guard.
     * Ошибка подтверждения закрывает именно процесс этого запуска перед удалением файлов.
     */
    const start: typeof startDeepSeekServer = async (input) => {
      const server = await (route.startServer ?? startDeepSeekServer)(input);

      try {
        const deadline = Date.now() + 10_000;
        let proof: unknown;

        while (Date.now() < deadline) {
          options.signal?.throwIfAborted();
          proof = await fs.readFile(proofPath, 'utf8').then((text) => JSON.parse(text), () => null);

          if (proof) {
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        if (!isRecord(proof) || proof.nonce !== nonce
          || JSON.stringify(proof.allowed) !== JSON.stringify(allowed)) {
          throw new Error('Исполнитель не подтвердил ограниченные инструменты триажа.');
        }

        return server;
      } catch (error) {
        await server.stop();

        throw error;
      }
    };

    return await runDeepSeekServerTurn({
      cwd: options.cwd,
      message: options.message,
      model: options.model,
      effort: options.effort,
      signal: options.signal,
      onStep: options.onStep,
      onProgress: options.onProgress,
      onRunMetadata: options.onRunMetadata,
      runtime: route.runtime,
      bin: route.runtime.command,
      overlayPath,
      env: {
        ...route.childEnv(home),
        HOME: home,
        TMPDIR: directory,
      },
      sessionId: null,
      permissionMode: 'auto',
      workToolNames: new Set(tools.descriptors.map((tool) => tool.name)),
      startServer: start,
    });
  } finally {
    await ipc?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
