import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { chatHomeFor, ensureHarnessChatHome, ensurePrivateDir } from '../deepseek/env.ts';
import { readProjectMcpServers } from '../deepseek/projectMcp.ts';
import type { DeepSeekRuntimeDescriptor } from '../deepseek/runtimeProcess.ts';
import { startDeepSeekServer } from '../deepseek/serverRuntime.ts';
import type { DeepSeekServerProcess, StartDeepSeekServerOptions } from '../deepseek/serverRuntime.ts';
import { assertGlmRuntimeHome } from './env.ts';
import { glmMcpStartupError, selectGlmMcpServers } from './mcp.ts';
import { buildGlmLaunchFiles } from './profile.ts';
import { adoptLegacyChatHome } from '../deepseek/legacyCutover.ts';
import type { GlmLaunchFilesOptions } from './profile.ts';

export const GLM_WORK_SERVER = 'grigdesk-work';

export interface GlmLaunchOptions extends Omit<GlmLaunchFilesOptions, 'launchDir' | 'settingsDocument'> {
  runtimeHome: string;
  identity: string;
  chatKey: string;
  launchDir?: string;
  warn?: (message: string) => void;
  homeLayout?: 'stable' | 'legacy';
}

/**
 * Новый home GLM зависит только от chatKey; три аргумента сохраняют legacy layout.
 * Любой chatKey хешируется и не превращается в путь вне private корня провайдера.
 */
export function glmChatHome(runtimeHome: string, identityOrChatKey: string, legacyChatKey?: string): string {
  if (legacyChatKey === undefined) {
    return chatHomeFor(runtimeHome, identityOrChatKey, 'stable');
  }

  const digest = createHash('sha256').update(legacyChatKey).digest('hex');

  return path.join(runtimeHome, identityOrChatKey.slice(0, 16), digest);
}

/**
 * Переносится только home совместимости, уже подтверждённой выбранным runtime.
 * Этот шаг предшествует проверке журнала и повторяется безопасно при подготовке overlay.
 */
export async function adoptLegacyGlmHome(runtimeHome: string, identity: string, chatKey: string) {
  await adoptLegacyChatHome({
    directory: glmChatHome(runtimeHome, chatKey),
    legacyDirectory: glmChatHome(runtimeHome, identity, chatKey),
    provider: 'glm',
    legacyIdentity: identity,
  });
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

  const stable = options.homeLayout === 'stable';
  const home = stable ? glmChatHome(runtimeHome, options.chatKey)
    : glmChatHome(runtimeHome, options.identity, options.chatKey);

  if (stable) {
    await adoptLegacyGlmHome(runtimeHome, options.identity, options.chatKey);
  }

  const dshHome = stable ? await ensureHarnessChatHome(home, 'glm') : await ensurePrivateDir(home);
  const launchDir = await ensurePrivateDir(options.launchDir
    ?? (stable ? path.join(dshHome, 'turns', randomUUID())
      : path.join(runtimeHome, options.identity.slice(0, 16), 'turns', randomUUID())));
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
    if ((error as { code?: unknown }).code !== 'deepseek_binary_cleanup') {
      await fs.rm(options.launch.launchDir, { recursive: true, force: true });
    }

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
