import { isTaskSourceId } from '../../shared/tasks/taskReference.ts';
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
function taskPath(id: string, tail = '', board?: string): string {
  return `${trackerPath(board)}/task/${encodeURIComponent(id)}${tail}`;
}

function trackerPath(board?: string): string {
  return board === undefined ? '/api/tracker' : `/api/tracker/${encodeURIComponent(board)}`;
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
async function specOf(
  command: Exclude<ApiCommand, { kind: 'start' | 'boards' | 'analyze' | 'launch-options' | 'launch' }>,
  io: CommandIO,
): Promise<RequestSpec> {
  switch (command.kind) {
    case 'dashboard':
      return {
        method: 'GET',
        path: `${trackerPath(command.board)}/dashboard`,
      };
    case 'task':
      return {
        method: 'GET',
        path: taskPath(command.id, '', command.board),
      };
    case 'comment':
      return {
        method: 'POST',
        path: taskPath(command.id, '/comment', command.board),
        body: JSON.stringify({ text: command.text }),
        json: true,
      };
    case 'timer':
      return {
        method: 'POST',
        path: taskPath(command.id, `/timer/${command.action}`, command.board),
      };
    case 'complete':
      return {
        method: 'POST',
        path: taskPath(command.id, '/complete', command.board),
      };
    case 'renew':
      return {
        method: 'POST',
        path: taskPath(command.id, '/renew', command.board),
      };
    case 'create':
      return {
        method: 'POST',
        path: `${trackerPath(command.board)}/tasks`,
        body: await stdinBody(io),
        json: true,
      };
    case 'users':
      return {
        method: 'GET',
        path: `${trackerPath(command.board)}/users?${new URLSearchParams({ q: command.query })}`,
      };
  }
}

/**
 * Новые операции конвейера подтверждают полный источник выбранной доски.
 * JSON запуска читается один раз; противоречие источников запрещено до POST.
 */
async function runPipelineCommand(
  command: {
    kind: 'analyze' | 'launch-options' | 'launch';
    id: string;
    board?: string;
  },
  connection: Connection,
  io: CommandIO,
): Promise<Uint8Array> {
  let body: Record<string, unknown> = {};

  if (command.kind === 'launch') {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(await io.readStdin()));

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error();
      }

      body = parsed as Record<string, unknown>;
    } catch {
      throw new B24Error(2, 'Запуск принимает JSON-объект из stdin.');
    }
  }

  let source: string | undefined;

  if (command.board !== undefined) {
    const bytes = await io.request(connection, {
      method: 'GET',
      path: `${trackerPath(command.board)}/context`,
    });
    let context: { source?: unknown };

    try {
      context = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new B24Error(22, 'Неверный ответ подключения доски.');
    }

    if (!isTaskSourceId(context?.source) || context.source.split('@')[0] !== command.board) {
      throw new B24Error(22, 'Не удалось подтвердить источник доски.');
    }

    source = context.source;

    if (body.source !== undefined && body.source !== source) {
      throw new B24Error(2, 'Источник stdin противоречит --board.');
    }

    body.source = source;
  }

  const path = `/api/tasks/${encodeURIComponent(command.id)}/${command.kind}`;

  if (command.kind === 'launch-options') {
    return io.request(connection, {
      method: 'GET',
      path: source ? `${path}?${new URLSearchParams({ source })}` : path,
    });
  }

  return io.request(connection, {
    method: 'POST',
    path,
    body: JSON.stringify(body),
    json: true,
  });
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
  if (command.kind === 'boards') {
    const body = await io.request(connection, { method: 'GET', path: '/api/trackers' });
    const catalog = JSON.parse(new TextDecoder().decode(body));
    const ids = catalog.enabledIds ?? (catalog.externalId ? [catalog.externalId] : []);
    const boards = ids.map((id: string) => {
      const descriptor = catalog.drivers.find((item: { id: string }) => item.id === id);

      return {
        id,
        name: descriptor?.name ?? id,
        status: descriptor?.status ?? 'unavailable',
        default: id === (catalog.default ?? catalog.externalId),
        reason: descriptor?.reason ?? null,
      };
    });

    return new TextEncoder().encode(JSON.stringify(boards));
  }

  if (command.kind === 'analyze' || command.kind === 'launch-options' || command.kind === 'launch') {
    return runPipelineCommand(command, connection, io);
  }

  if (command.kind !== 'start') {
    return await io.request(connection, await specOf(command, io));
  }

  try {
    await io.request(connection, {
      method: 'POST',
      path: taskPath(command.id, '/renew', command.board),
    });
  } catch (error) {
    if (!(error instanceof B24Error) || error.code !== 22) {
      throw error;
    }
  }

  return await io.request(connection, {
    method: 'POST',
    path: taskPath(command.id, '/timer/start', command.board),
  });
}
