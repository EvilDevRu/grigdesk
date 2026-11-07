#!/usr/bin/env node
// Фейковый `kimi web`: пишет токен в KIMI_CODE_HOME/server.token, печатает адрес и
// обслуживает /api/v1/meta. Нужен, чтобы проверить runtime без настоящего сервера Kimi.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const portAt = argv.indexOf('--port');
const port = Number(argv[portAt + 1] || 0);
const home = process.env.KIMI_CODE_HOME || '/tmp';

if (argv[0] !== 'web' || !port) {
  process.stderr.write(`fake-kimi: ожидался вызов web --port <port>, получено: ${argv.join(' ')}\n`);
  process.exit(64);
}

mkdirSync(home, { recursive: true });

if (process.env.GRIGDESK_KIMI_FIXTURE_MODE === 'crash') {
  process.stderr.write('fake-kimi: сервер не поднялся (сценарий crash)\n');
  process.exit(3);
}

const token = process.env.GRIGDESK_KIMI_FIXTURE_TOKEN || 'fixture-token-0123456789';
const server = createServer((request, response) => {
  if (request.url === '/api/v1/meta') {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 40101, msg: 'unauthorized' }));
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      code: 0,
      data: { server_version: '0.33.0-fixture', capabilities: { websocket: true } },
    }));
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ code: 40400, msg: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
  writeFileSync(path.join(home, 'server.token'), `${token}\n`, 'utf8');
  process.stdout.write(`Kimi server: http://127.0.0.1:${port}/#token=${token}\n`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
