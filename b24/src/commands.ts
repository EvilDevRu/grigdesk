import type { ApiCommand } from './args.ts';
import type { Connection } from './config.ts';
import { B24Error } from './errors.ts';
import { request } from './http.ts';
import type { RequestSpec } from './http.ts';

export interface CommandIO {
  request: typeof request;
  readStdin(): Promise<Uint8Array>;
}

/**
 * Путь задачи с ID, закодированным как один сегмент URL.
 * Числовая нормализация остаётся на сервере.
 */
function taskPath(id: string, tail = ''): string {
  return `/api/tracker/task/${encodeURIComponent(id)}${tail}`;
}

/**
 * Читает stdin create ровно один раз и не меняет байты.
 * Отказ чтения превращается в код 1 до HTTP.
 */
async function stdinBody(io: CommandIO): Promise<Uint8Array> {
  try {
    return await io.readStdin();
  } catch {
    throw new B24Error(1, 'Не удалось прочитать JSON из stdin.');
  }
}

/**
 * Описание единственного запроса команды; start собирается отдельно.
 * POST без тела не получает JSON-заголовок и пустой объект.
 */
async function specOf(command: Exclude<ApiCommand, { kind: 'start' }>, io: CommandIO): Promise<RequestSpec> {
  switch (command.kind) {
    case 'dashboard':
      return {
        method: 'GET',
        path: '/api/tracker/dashboard',
      };
    case 'task':
      return {
        method: 'GET',
        path: taskPath(command.id),
      };
    case 'comment':
      return {
        method: 'POST',
        path: taskPath(command.id, '/comment'),
        body: JSON.stringify({ text: command.text }),
        json: true,
      };
    case 'timer':
      return {
        method: 'POST',
        path: taskPath(command.id, `/timer/${command.action}`),
      };
    case 'complete':
      return {
        method: 'POST',
        path: taskPath(command.id, '/complete'),
      };
    case 'renew':
      return {
        method: 'POST',
        path: taskPath(command.id, '/renew'),
      };
    case 'create':
      return {
        method: 'POST',
        path: '/api/tracker/tasks',
        body: await stdinBody(io),
        json: true,
      };
    case 'users':
      return {
        method: 'GET',
        path: `/api/tracker/users?${new URLSearchParams({ q: command.query })}`,
      };
  }
}

/**
 * Выполняет команду API и возвращает тело последнего успешного ответа.
 * start последовательно делает renew, глотает его HTTP/сетевой отказ и один раз запускает таймер.
 */
export async function runCommand(
  command: ApiCommand,
  connection: Connection,
  io: CommandIO,
): Promise<Uint8Array> {
  if (command.kind !== 'start') {
    return await io.request(connection, await specOf(command, io));
  }

  try {
    await io.request(connection, {
      method: 'POST',
      path: taskPath(command.id, '/renew'),
    });
  } catch (error) {
    if (!(error instanceof B24Error) || error.code !== 22) {
      throw error;
    }
  }

  return await io.request(connection, {
    method: 'POST',
    path: taskPath(command.id, '/timer/start'),
  });
}
