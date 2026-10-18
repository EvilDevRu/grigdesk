import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ensurePrivateDir } from '../deepseek/env.ts';
import { readProjectMcpServers } from '../deepseek/projectMcp.ts';
import type { DeepSeekRuntimeDescriptor } from '../deepseek/runtimeProcess.ts';
import { startDeepSeekServer } from '../deepseek/serverRuntime.ts';
import type { DeepSeekServerProcess, StartDeepSeekServerOptions } from '../deepseek/serverRuntime.ts';
import { assertGlmRuntimeHome } from './env.ts';
import { glmMcpStartupError, selectGlmMcpServers } from './mcp.ts';
import { buildGlmLaunchFiles } from './profile.ts';
import type { GlmLaunchFilesOptions } from './profile.ts';

export const GLM_WORK_SERVER = 'grigdesk-work';

export interface GlmLaunchOptions extends Omit<GlmLaunchFilesOptions, 'launchDir' | 'settingsDocument'> {
  runtimeHome: string;
  identity: string;
  chatKey: string;
  launchDir?: string;
  warn?: (message: string) => void;
}

/**
 * Home чата GLM: корень, первые 16 символов identity сборки и sha256 ключа чата.
 * Любой chatKey, в том числе с `../`, превращается в имя файла и не выходит из корня.
 */
export function glmChatHome(runtimeHome: string, identity: string, chatKey: string): string {
  const digest = createHash('sha256').update(chatKey).digest('hex');

  return path.join(runtimeHome, identity.slice(0, 16), digest);
}

/**
 * Готовит один запуск процесса GLM: private home чата, одноразовый каталог запуска,
 * server-owned settings-документ и overlay. Проектные MCP не подключаются (факт G2):
 * каждый проектный сервер даёт предупреждение, а в overlay попадает только grigdesk-work.
 */
export async function prepareGlmLaunch(options: GlmLaunchOptions) {
  const runtimeHome = assertGlmRuntimeHome(options.runtimeHome);

  if (!/^[a-f0-9]{64}$/u.test(options.identity) || !options.chatKey) {
    throw new TypeError('GLM launch требует identity сборки и server-owned chatKey');
  }

  const dshHome = await ensurePrivateDir(glmChatHome(runtimeHome, options.identity, options.chatKey));
  const launchDir = await ensurePrivateDir(options.launchDir
    ?? path.join(runtimeHome, options.identity.slice(0, 16), 'turns', randomUUID()));
  const settingsDocument = path.join(dshHome, 'settings.yaml');
  const project = await readProjectMcpServers(options.cwd);
  const selected = selectGlmMcpServers({ chat: options.mcpServers ?? [], project: project.servers });

  for (const warning of selected.warnings) {
    options.warn?.(warning);
  }

  // Пользовательская секция llm-pi-ai переопределила бы маршрут на каждый запрос.
  await fs.writeFile(settingsDocument, '{}\n', { mode: 0o600 });
  await fs.chmod(settingsDocument, 0o600);

  const files = await buildGlmLaunchFiles({
    ...options,
    launchDir,
    settingsDocument,
    mcpServers: selected.mounted,
  });

  return {
    ...files,
    dshHome,
    settingsDocument,
  };
}

/**
 * Production-запуск web-процесса GLM: проверенная generation, окружение allowlist и
 * overlay этого запуска. Остановка завершает только свой процесс и удаляет каталог запуска;
 * home чата с журналом сессии остаётся.
 */
export async function startGlmProcess(options: {
  runtime: DeepSeekRuntimeDescriptor;
  launch: { overlayPath: string; launchDir: string };
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  spawnProcess?: StartDeepSeekServerOptions['spawnProcess'];
  startServer?: (options: StartDeepSeekServerOptions) => Promise<DeepSeekServerProcess>;
}): Promise<DeepSeekServerProcess> {
  let server: DeepSeekServerProcess;
  let diagnostics = '';
  // Хвост stderr нужен только для причины отказа старта; токен входа из него не выходит.
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    const child = (options.spawnProcess ?? spawn)(...args);

    child.stderr?.on('data', (chunk) => {
      diagnostics = (diagnostics + String(chunk)).slice(-16_384);
    });

    return child;
  }) as typeof spawn;

  try {
    server = await (options.startServer ?? startDeepSeekServer)({
      runtime: options.runtime,
      bin: options.runtime.command,
      overlayPath: options.launch.overlayPath,
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      spawnProcess,
    });
  } catch (error) {
    await fs.rm(options.launch.launchDir, { recursive: true, force: true });

    throw glmMcpStartupError(diagnostics) ?? error;
  }

  let stopped: Promise<void> | null = null;

  return {
    client: server.client,
    stop: () => {
      stopped ??= (async () => {
        await server.stop();
        await fs.rm(options.launch.launchDir, { recursive: true, force: true });
      })();

      return stopped;
    },
  };
}
