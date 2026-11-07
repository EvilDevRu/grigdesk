#!/usr/bin/env node
// Синтетический Kimi в отдельной сети: HTTP слушает внутренний TCP, наружу ведёт Unix socket.
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const [home, socketPath] = process.argv.slice(2);
const token = 'fixture-token-0123456789';
const inner = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end('{}');

    return;
  }

  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ code: 0, data: { server_version: 'contained-fixture' } }));
});

await mkdir(home, { recursive: true });
await mkdir(path.dirname(socketPath), { recursive: true });
await writeFile(path.join(home, 'server.token'), token, { mode: 0o600 });
await new Promise((resolve) => inner.listen(0, '127.0.0.1', resolve));

const innerPort = inner.address().port;
const bridge = net.createServer((outside) => {
  const inside = net.createConnection(innerPort, '127.0.0.1');

  outside.on('error', () => inside.destroy());
  inside.on('error', () => outside.destroy());
  outside.pipe(inside);
  inside.pipe(outside);
});

await new Promise((resolve) => bridge.listen(socketPath, resolve));

process.on('SIGTERM', () => {
  bridge.close();
  inner.close(() => process.exit(0));
});
