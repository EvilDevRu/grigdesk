import path from 'node:path';

import { readProjectMcpServers } from './projectMcp.ts';
import type { ProjectMcpServer } from './projectMcp.ts';

export interface DeepSeekMcpConfig {
  rootDir?: string;
}

export interface DeepSeekMcpServerCard {
  name: string;
  target: '';
  scope: 'project';
  state: 'configured';
  detail: '';
}

export type DeepSeekMcpStatus = {
  state: 'ok';
  note: string;
  emptyText: string;
  servers: DeepSeekMcpServerCard[];
} | {
  state: 'error';
  error: string;
  servers: [];
};

const NOTE = 'Показана конфигурация MCP для папки кокпита. '
  + 'В другой папке чата список может отличаться. '
  + 'Соединение не проверялось. Показаны только stdio-серверы, выбранные для запуска.';
const PARTIAL_NOTE = 'Конфигурация MCP для папки кокпита прочитана или проверена не полностью. '
  + 'Список может быть неполным; проверьте `.mcp.json` и команды запуска.';
const EMPTY_TEXT = 'Для папки кокпита нет MCP-серверов, выбранных для запуска.';
const LIST_ERROR = 'Не удалось получить список MCP для папки кокпита. '
  + 'Проверьте `.mcp.json` и команды запуска.';
const READ_ERROR = 'Не удалось прочитать конфигурацию MCP для папки кокпита.';
const ROOT_ERROR = 'Для списка MCP не задана абсолютная папка кокпита.';

/**
 * Публичный список содержит только имена уже выбранных reader-серверов.
 * Команды и окружение остаются на сервере; сортировка не меняет исходный массив.
 */
export function composeDeepSeekMcpServers(
  servers: readonly ProjectMcpServer[],
): DeepSeekMcpServerCard[] {
  return servers
    .map((server): DeepSeekMcpServerCard => ({
      name: server.name,
      target: '',
      scope: 'project',
      state: 'configured',
      detail: '',
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru'));
}

/**
 * Читает тот же проектный источник, что и чат, для явно заданной папки кокпита.
 * Ошибки чтения и проекции скрывают внутренние данные; хорошие записи сохраняются.
 */
export async function readDeepSeekMcpStatus(
  config: DeepSeekMcpConfig,
  deps: { readProject?: typeof readProjectMcpServers } = {},
): Promise<DeepSeekMcpStatus> {
  const rootDir = config?.rootDir;

  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) {
    return {
      state: 'error',
      error: ROOT_ERROR,
      servers: [],
    };
  }

  try {
    const read = await (deps.readProject || readProjectMcpServers)(rootDir);
    const servers = composeDeepSeekMcpServers(read.servers);
    const partial = read.warnings.length > 0;

    if (partial && !servers.length) {
      return {
        state: 'error',
        error: LIST_ERROR,
        servers: [],
      };
    }

    return {
      state: 'ok',
      note: partial ? `${NOTE} ${PARTIAL_NOTE}` : NOTE,
      emptyText: EMPTY_TEXT,
      servers,
    };
  } catch {
    return {
      state: 'error',
      error: READ_ERROR,
      servers: [],
    };
  }
}
