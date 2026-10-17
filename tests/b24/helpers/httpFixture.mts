import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { TestContext } from 'node:test';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface HttpFixture {
  baseUrl: string;
  requests: RecordedRequest[];
}

export type FixtureHandler = (
  request: RecordedRequest,
  response: ServerResponse<IncomingMessage>,
) => void | Promise<void>;

/**
 * Поднимает HTTP-фейк только на 127.0.0.1:0 и записывает каждый запрос целиком.
 * Очистка регистрируется до ожидания listen: сокеты закрываются, затем ждём close.
 */
export async function startHttpFixture(t: TestContext, handler: FixtureHandler): Promise<HttpFixture> {
  const sockets = new Set<Socket>();
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const recorded = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks),
      };

      requests.push(recorded);
      void Promise.resolve(handler(recorded, response)).catch(() => {
        response.socket?.destroy();
      });
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address !== 'object') {
    throw new Error('Фикстура HTTP не получила порт');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
  };
}

/**
 * Отправляет тело несколькими кусками, чтобы клиент собирал ответ из chunks.
 * Content-Length не задаётся: ответ идёт chunked.
 */
export function sendChunked(
  response: ServerResponse,
  status: number,
  body: Buffer,
  type = 'application/json',
): void {
  response.writeHead(status, { 'Content-Type': type });

  for (let offset = 0; offset < body.length; offset += 3) {
    response.write(body.subarray(offset, offset + 3));
  }

  response.end();
}
