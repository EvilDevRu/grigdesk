// Клиент Docker Engine API поверх локального unix-сокета.
//
// Почему сокет, а не CLI `docker`: ответы демона — уже JSON с полными полями (лейблы
// compose, порты, health, точный размер), их не нужно разбирать из колонок вывода,
// который меняется между версиями CLI. Плюс тот же сокет даёт потоки логов, статистики
// и hijack-канал exec — три вещи, ради которых иначе пришлось бы держать дочерние процессы.
//
// Прав это не добавляет: сокет принадлежит группе docker, в которой человек уже состоит,
// а сервер кокпита host-native и работает под его uid. Плагин здесь — не мост наружу,
// а окно в то, что и так доступно из терминала этой машины.
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

import type { DockerLogFrame } from '../../../../shared/plugins/docker/dockerContracts.ts';

export type DockerQuery = Record<string, unknown>;

export interface DockerRequestOptions {
  query?: DockerQuery;
  body?: unknown;
  timeoutMs?: number;
}

export interface DockerStream {
  res: IncomingMessage;
  abort(): void;
}

export interface DockerClientOptions {
  socketPath?: string;
}

export type DockerClient = ReturnType<typeof createDockerClient>;

export const DEFAULT_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';

// Демон обрывает лишь то, что не успел отдать: короткий таймаут на обычный запрос
// защищает панель от вечной «Загрузки…», а потоки живут без него.
const REQUEST_TIMEOUT_MS = 20_000;

/** Сборка query-строки: пустые и неопределённые параметры не попадают в путь. */
function buildQuery(query: DockerQuery = {}): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  const text = params.toString();

  return text ? `?${text}` : '';
}

/**
 * Ошибка демона с сохранённым HTTP-статусом: модуль по нему выбирает код ответа,
 * а панель — текст. Сообщение демона («conflict: container is running») человеку
 * понятнее любого нашего пересказа, поэтому оно доносится дословно.
 */
export class DockerError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 500, code = 'docker_error') {
    super(message);
    this.name = 'DockerError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Тело ошибки остаётся недоверенным JSON: только поле message заменяет сырой ответ,
 * остальные поля демона не могут подменить HTTP-статус и локальный код ошибки.
 */
function decodeFailure(status: number, text: string): DockerError {
  let message = text;

  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed === 'object' && parsed !== null && 'message' in parsed && parsed.message) {
      message = String(parsed.message);
    }
  } catch {
    // Демон ответил не JSON — берём тело как есть.
  }

  const code = status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'docker_error';

  return new DockerError(message || `HTTP ${status}`, status, code);
}

/**
 * Каждый клиент привязан к одному локальному сокету. Ответы остаются unknown,
 * поскольку проверить конкретную форму Docker Engine может только вызывающий сервис.
 */
export function createDockerClient({ socketPath = DEFAULT_SOCKET_PATH }: DockerClientOptions = {}) {
  /**
   * Одиночный запрос к демону. Возвращает уже разобранное тело: у Docker есть
   * ответы 204 без содержимого, поэтому пустое тело — это null, а не ошибка разбора.
   */
  function request(
    method: string,
    path: string,
    { query, body, timeoutMs = REQUEST_TIMEOUT_MS }: DockerRequestOptions = {},
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        socketPath,
        method,
        path: path + buildQuery(query),
        headers: {
          Host: 'docker',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      });

      req.on('response', (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 500;

          if (status >= 400) {
            reject(decodeFailure(status, text));
            return;
          }

          if (!text) {
            resolve(null);
            return;
          }

          try {
            const parsed: unknown = JSON.parse(text);

            resolve(parsed);
          } catch {
            resolve(text);
          }
        });
      });

      req.on('error', (error) => reject(wrapTransport(error)));

      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new DockerError('демон не ответил вовремя', 504, 'docker_timeout'));
        });
      }

      if (payload) {
        req.write(payload);
      }

      req.end();
    });
  }

  /**
   * Поток от демона (логи, статистика, события): вызывающий сам читает `res` и сам
   * решает, когда прекратить — поэтому здесь нет таймаута, а есть `abort()`.
   */
  function stream(
    method: string,
    path: string,
    { query }: Pick<DockerRequestOptions, 'query'> = {},
  ): Promise<DockerStream> {
    return new Promise<DockerStream>((resolve, reject) => {
      const req = http.request({
        socketPath,
        method,
        path: path + buildQuery(query),
        headers: { Host: 'docker' },
      });

      req.on('response', (res) => {
        const status = res.statusCode ?? 500;

        if (status >= 400) {
          const chunks: Buffer[] = [];

          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => reject(decodeFailure(status, Buffer.concat(chunks).toString('utf8'))));
          return;
        }

        resolve({
          res,
          abort: () => {
            req.destroy();
          },
        });
      });

      req.on('error', (error) => reject(wrapTransport(error)));
      req.end();
    });
  }

  /**
   * Hijack-канал exec: демон отдаёт 101 и превращает соединение в двунаправленный
   * поток байтов. Обычный http-ответ здесь не приходит вовсе, поэтому ждём событие
   * `upgrade` и работаем с голым сокетом — так же, как это делает сам docker CLI.
   */
  function hijack(path: string, body: unknown = {}): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const req = http.request({
        socketPath,
        method: 'POST',
        path,
        headers: {
          Host: 'docker',
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Connection: 'Upgrade',
          Upgrade: 'tcp',
        },
      });

      req.on('upgrade', (_res, socket, head) => {
        socket.setNoDelay(true);

        // Вывод может прийти вместе с HTTP 101: вернём уже прочитанные байты потребителю.
        if (head.length) {
          socket.unshift(head);
        }

        resolve(socket);
      });
      // Демон отвечает обычным ответом, когда апгрейд невозможен: чаще всего это
      // 404 на уже убранный exec или 409 на остановленный контейнер.
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        const status = res.statusCode ?? 500;

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => reject(decodeFailure(status, Buffer.concat(chunks).toString('utf8'))));
      });
      req.on('error', (error) => reject(wrapTransport(error)));
      req.write(payload);
      req.end();
    });
  }

  return {
    socketPath,
    request,
    stream,
    hijack,
    get: (path: string, query?: DockerQuery) => request('GET', path, { query }),
    post: (path: string, options?: DockerRequestOptions) => request('POST', path, options),
    del: (path: string, query?: DockerQuery) => request('DELETE', path, { query }),
  };
}

/**
 * Отказ транспорта — самая частая беда этого плагина, и она не про Docker API:
 * демон не запущен, сокет лежит по другому пути или у процесса нет группы docker.
 * Панель должна сказать это словами, поэтому различаем причины здесь, а не в UI.
 */
function wrapTransport(error: unknown): DockerError {
  if (error instanceof DockerError) {
    return error;
  }

  const code = error instanceof Error && 'code' in error ? error.code : null;

  if (code === 'ENOENT') {
    return new DockerError('сокет Docker не найден — демон не запущен', 503, 'docker_unavailable');
  }

  if (code === 'ECONNREFUSED') {
    return new DockerError('демон Docker не принимает соединения', 503, 'docker_unavailable');
  }

  if (code === 'EACCES') {
    return new DockerError('нет доступа к сокету Docker — нужна группа docker', 403, 'docker_forbidden');
  }

  const message = error instanceof Error ? error.message : '';

  return new DockerError(message || 'сбой обращения к Docker', 502, 'docker_error');
}

/**
 * Демультиплексор потока логов контейнера без TTY: демон склеивает stdout и stderr
 * в один поток кадрами «8 байт заголовка + тело», и без разбора кадров в терминале
 * появляется мусор из служебных байтов. У контейнера с TTY кадров нет — там поток сырой.
 */
export function createLogDemuxer(): (chunk: Buffer) => DockerLogFrame[] {
  let buffer: Buffer = Buffer.alloc(0);

  return function push(chunk: Buffer): DockerLogFrame[] {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    const frames: DockerLogFrame[] = [];

    while (buffer.length >= 8) {
      const size = buffer.readUInt32BE(4);

      if (buffer.length < 8 + size) {
        break;
      }

      frames.push({
        stream: buffer[0] === 2 ? 'stderr' : 'stdout',
        text: buffer.subarray(8, 8 + size).toString('utf8'),
      });
      buffer = buffer.subarray(8 + size);
    }

    return frames;
  };
}
