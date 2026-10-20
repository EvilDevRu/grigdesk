import path from 'node:path';

import { readProjectMcpServers } from '../deepseek/projectMcp.ts';
import { glmAccessError } from './env.ts';
import { GLM_WORK_SERVER_NAME } from './policy.ts';

export interface GlmMcpServer {
  name: string;
  command: string;
  args: readonly string[];
  env: readonly { name: string; value: string }[];
}

export type GlmMcpExclusion = 'name_invalid' | 'reserved' | 'project_unsupported';

// Имя сервера однозначно читается из имени инструмента `mcp__<сервер>__<инструмент>`:
// без `__` и без `_` на краях, от двух до 32 символов.
const SERVER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]|_(?!_))*[A-Za-z0-9]$/u;
const NOT_READY = 'Служебный MCP grigdesk-work не готов или потерян; действие не выполнено.';

/**
 * Шаблон имени MCP-сервера GLM: 2–32 символа, без `__` и `_` на краях.
 * Имя из одного символа шаблон отсекает сознательно.
 */
export function glmMcpServerNameAllowed(name: string): boolean {
  return typeof name === 'string' && name.length <= 32 && SERVER_NAME.test(name);
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
    warnings: excluded.map(({ name, reason }) => `MCP-сервер «${name}» не подключается к GLM: ${
      reason === 'reserved' ? 'имя зарезервировано GrigDesk'
        : reason === 'name_invalid' ? 'имя не подходит под шаблон' : 'проектные MCP GLM не использует'}.`),
  };
}

/**
 * Публичный статус MCP карточки: проектные серверы папки GrigDesk не подключаются,
 * поэтому список пуст, а заметка называет только их число — без имён, команд и env.
 */
export async function glmMcpStatus(config: { rootDir?: string }) {
  let count = 0;

  if (config.rootDir && path.isAbsolute(config.rootDir)) {
    count = (await readProjectMcpServers(config.rootDir).catch(() => ({ servers: [] }))).servers.length;
  }

  return {
    state: 'ok' as const,
    note: `GLM подключает только служебный MCP grigdesk-work. ${count
      ? `${count} проектн. MCP-сервер(ов) из .mcp.json папки GrigDesk в этой поставке не запускаются.`
      : 'Проектные MCP-серверы из .mcp.json в этой поставке не запускаются.'}`,
    emptyText: 'Для GLM проектные MCP не используются: доступен только служебный grigdesk-work.',
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

  return /\bNot connected\b|Connection closed/iu.test(JSON.stringify(content ?? ''))
    ? glmAccessError('glm_mcp_not_ready', hostServer === GLM_WORK_SERVER_NAME ? NOT_READY
      : `Служебный MCP ${hostServer} не готов или потерян; действие не выполнено.`) : null;
}
