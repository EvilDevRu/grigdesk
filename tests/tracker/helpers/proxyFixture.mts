import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { TestContext } from 'node:test';

interface ProxyCalls {
  connections: number;
  requests: number;
  connects: number;
}

export interface ProxyFixture {
  baseUrl: string;
  calls: ProxyCalls;
}

/**
 * Принимает обычные запросы и CONNECT только на loopback и отвечает своим маркером.
 * Считает все соединения: тест прямого транспорта замечает даже попытку обратиться к прокси.
 */
export async function startProxyFixture(t: TestContext): Promise<ProxyFixture> {
  const calls: ProxyCalls = {
    connections: 0,
    requests: 0,
    connects: 0,
  };
  const sockets = new Set<Socket>();
  const body = '{"via":"proxy"}';
  const server = createServer((_request, response) => {
    calls.requests += 1;
    response.end(body);
  });

  server.on('connect', (_request, socket, head) => {
    calls.connects += 1;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    let received = head.toString('latin1');
    const respond = () => {
      if (received.includes('\r\n\r\n')) {
        socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n'
          + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      }
    };

    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
      respond();
    });
    respond();
  });
  server.on('connection', (socket) => {
    calls.connections += 1;
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
    throw new Error('Фикстура прокси не получила порт');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
  };
}
