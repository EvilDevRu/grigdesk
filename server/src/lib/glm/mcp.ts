import path from 'node:path';

import { readProjectMcpServers } from '../deepseek/projectMcp.ts';
import { glmAccessError } from './env.ts';
import { GLM_WORK_SERVER_NAME, glmMcpServerNameAllowed, glmProjectMcpNameAllowed } from './policy.ts';
import type { GlmTurnOptions } from './runtime.ts';

export { glmMcpServerNameAllowed } from './policy.ts';

export interface GlmMcpServer {
  name: string;
  command: string;
  args: readonly string[];
  env: readonly { name: string; value: string }[];
}

export type GlmMcpExclusion = 'name_invalid' | 'reserved' | 'project_unsupported';

const NOT_READY = 'Служебный MCP grigdesk-work не готов или потерян; действие не выполнено.';

/**
 * Предпросмотр отдаёт только доступные для явного выбора имена.
 * Чтение конфигурации не запускает проектный процесс.
 */
export async function listGlmProjectMcpNames(cwd: string): Promise<string[]> {
  const { servers } = await readProjectMcpServers(cwd);

  return servers.map(({ name }) => name).filter(glmProjectMcpNameAllowed);
}

/**
 * Какие MCP получает процесс GLM: только служебный сервер хоста — grigdesk-work чата либо
 * статус этапа фабрики. Проектные серверы в поставку не входят, каждый — с предупреждением.
 */
export function selectGlmMcpServers({
  chat,
  project,
  hostServer = GLM_WORK_SERVER_NAME,
}: {
  chat: readonly GlmMcpServer[];
  project: readonly GlmMcpServer[];
  hostServer?: string;
}) {
  const mounted: GlmMcpServer[] = [];
  const excluded: { name: string; reason: GlmMcpExclusion }[] = [];

  for (const server of chat) {
    if (server.name === hostServer && glmMcpServerNameAllowed(server.name)) {
      mounted.push(server);
    } else {
      excluded.push({
        name: server.name,
        reason: glmMcpServerNameAllowed(server.name) ? 'project_unsupported' : 'name_invalid',
      });
    }
  }

  for (const server of project) {
    excluded.push({
      name: server.name,
      reason: server.name === hostServer ? 'reserved'
        : glmMcpServerNameAllowed(server.name) ? 'project_unsupported' : 'name_invalid',
    });
  }

  return {
    mounted,
    excluded,
    warnings: excluded.map(({ name, reason }) => `MCP-сервер «${name}» не подключён к GLM: ${
      reason === 'reserved' ? 'имя зарезервировано GrigDesk'
        : reason === 'name_invalid' ? 'имя не подходит под шаблон' : 'требуется явный выбор в чате'}.`),
  };
}

/**
 * Только прямой выбор пользователя разрешает показать запрос на запуск процесса.
 * После подтверждения повторно сверяем выбранную запись и передаём ровно этот снимок.
 */
export async function approveGlmProjectMcp(
  cwd: string, options: GlmTurnOptions,
): Promise<GlmMcpServer | undefined> {
  const name = options.userMessage?.trim().match(/^(?:\/goal\s+)?\/mcp\s+(\S+)(?:\s|$)/u)?.[1];

  if (!name) {
    return;
  }

  const findServer = async () => (await readProjectMcpServers(cwd)).servers.find((server) => server.name === name);
  const server = glmProjectMcpNameAllowed(name) ? await findServer() : undefined;

  if (!server) {
    throw glmAccessError('glm_project_mcp_unknown', 'Выбранный проектный MCP недоступен в рабочей папке.');
  }

  const answer = await options.onPermission?.({
    tool: `MCP: ${name}`,
    source: 'GLM',
    requiresExplicitUser: true,
    canRemember: false,
    signal: options.signal,
    input: {
      kind: 'execute',
      command: [server.command, ...server.args].map((part) => JSON.stringify(part)).join(' '),
      cwd,
    },
  });

  options.signal?.throwIfAborted();

  if (answer?.allow !== true) {
    throw glmAccessError('glm_project_mcp_declined', 'Запуск проектного MCP не подтверждён.');
  }
  if (JSON.stringify(await findServer()) !== JSON.stringify(server)) {
    throw glmAccessError('glm_project_mcp_changed', 'Настройки проектного MCP изменились во время подтверждения.');
  }

  return server;
}

/**
 * Публичный статус MCP карточки относится к папке приложения.
 * Выбор сервера производится в чате с фактической рабочей папкой.
 */
export async function glmMcpStatus(config: { rootDir?: string }) {
  let count = 0;

  if (config.rootDir && path.isAbsolute(config.rootDir)) {
    count = (await readProjectMcpServers(config.rootDir).catch(() => ({ servers: [] }))).servers.length;
  }

  return {
    state: 'ok' as const,
    note: `Служебный MCP grigdesk-work подключается автоматически. ${count
      ? `${count} проектн. MCP в папке GrigDesk. ` : ''}`
      + 'В каждом чате доступные проектные серверы определяются его рабочей папкой.',
    emptyText: 'Чтобы запустить проектные MCP, выберите сервер в окне доступа чата GLM.',
    servers: [],
  };
}

/**
 * Отказ запуска из-за служебного MCP хоста: с failOnStartupError DSH завершается до адреса
 * web с диагностикой mcp-client. Остальные сбои запуска остаются сбоем запуска.
 */
export function glmMcpStartupError(
  text: string,
  hostServer = GLM_WORK_SERVER_NAME,
): (Error & { code: string }) | null {
  return text.includes(`mcp-client(${hostServer}): initial connection or tool synchronization failed`)
    ? glmAccessError('glm_mcp_not_ready', hostServer === GLM_WORK_SERVER_NAME ? NOT_READY
      : `Служебный MCP ${hostServer} не готов или потерян; действие не выполнено.`) : null;
}

/**
 * Потеря служебного MCP хоста после готовности: DSH отвечает на вызов ошибкой «Not connected»
 * и продолжает ход. Для GLM это остановка хода, а не обычная ошибка инструмента.
 */
export function glmMcpLossError(
  name: string,
  content: unknown,
  isError: boolean,
  hostServer = GLM_WORK_SERVER_NAME,
): (Error & { code: string }) | null {
  if (!isError || !name.startsWith(`mcp__${hostServer}__`)) {
    return null;
  }

  const result = JSON.stringify(content ?? '');
  const disconnected = result.includes(`mcp-client(${hostServer}): server is disconnected`);

  return disconnected || /\bNot connected\b|Connection closed/iu.test(result)
    ? glmAccessError('glm_mcp_not_ready', hostServer === GLM_WORK_SERVER_NAME ? NOT_READY
      : `Служебный MCP ${hostServer} не готов или потерян; действие не выполнено.`) : null;
}
