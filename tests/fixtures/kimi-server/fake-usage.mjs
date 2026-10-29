#!/usr/bin/env node
// Брокер лимитов с npm-shebang проверяет настоящий поиск Node через PATH.
// Он обслуживает только локальную статистику и остановку, без аккаунта и модели.
import { createServer } from 'node:http';

const token = 'usage-fixture-token';
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');

  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401);
    response.end('{}');

    return;
  }

  if (request.url.startsWith('/api/v1/oauth/usage?')) {
    response.end(JSON.stringify({
      data: {
        kind: 'ok',
        summary: {
          used: 1,
          limit: 10,
          fixturePath: process.env.PATH,
        },
      },
    }));

    return;
  }

  if (request.method === 'POST' && request.url === '/api/v1/shutdown') {
    response.end('{}');
    server.close();

    return;
  }

  response.writeHead(404);
  response.end('{}');
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();

  process.stdout.write(`Kimi server: http://127.0.0.1:${port}/#token=${token}\n`);
});
