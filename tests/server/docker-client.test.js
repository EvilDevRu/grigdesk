import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDockerClient,
  createLogDemuxer,
} from '../../server/src/lib/docker/client.ts';

/**
 * Транспорт проверяется настоящим HTTP по временному unix-сокету. Поддельный демон
 * изолирован от Docker хоста; все соединения и файлы убираются даже при ошибке теста.
 */
async function fakeEngine(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'grigdesk-docker-client-'));
  const socketPath = join(directory, 'engine.sock');
  const server = http.createServer(handler);
  const sockets = new Set();

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }

    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }

    await rm(directory, { recursive: true, force: true });
  });

  server.listen(socketPath);
  await once(server, 'listening');

  return { server, client: createDockerClient({ socketPath }) };
}

/**
 * Чтение тестового тела не включает setEncoding: бинарные ответы должны пройти
 * через тот же Buffer-контракт, что используется потоками Docker Engine.
 */
async function readBytes(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

test('unix HTTP сохраняет JSON, query-фильтры, пустой 204 и текстовый ответ', async (t) => {
  const requests = [];
  const { client } = await fakeEngine(t, async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: (await readBytes(request)).toString('utf8'),
    });

    if (request.url === '/empty') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.url === '/_ping') {
      response.end('OK');
      return;
    }

    response.end(JSON.stringify({ Id: 'fake-container', State: { Running: true } }));
  });

  assert.deepEqual(await client.post('/containers/create', {
    query: {
      all: false,
      limit: 0,
      filters: { label: ['compose.project=demo'] },
      empty: '',
      missing: undefined,
      nullable: null,
    },
    body: { Cmd: ['sh', '-c', 'printf привет'], Tty: true },
  }), { Id: 'fake-container', State: { Running: true } });

  const request = requests[0];
  const query = new URL(request.url, 'http://docker').searchParams;

  assert.equal(request.method, 'POST');
  assert.equal(query.get('all'), 'false');
  assert.equal(query.get('limit'), '0');
  assert.deepEqual(JSON.parse(query.get('filters')), { label: ['compose.project=demo'] });
  assert.equal(query.size, 3);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(Number(request.headers['content-length']), Buffer.byteLength(request.body));
  assert.deepEqual(JSON.parse(request.body), { Cmd: ['sh', '-c', 'printf привет'], Tty: true });

  assert.equal(await client.del('/empty'), null);
  assert.equal(await client.get('/_ping'), 'OK');
});

test('ошибки HTTP сохраняют статус и сообщение для запросов, потоков и exec', async (t) => {
  const { client } = await fakeEngine(t, (request, response) => {
    if (request.url === '/missing') {
      response.writeHead(404);
      response.end(JSON.stringify({ message: 'нет такого контейнера', status: 200 }));
      return;
    }

    response.writeHead(409);
    response.end('контейнер остановлен');
  });

  for (const action of [
    () => client.get('/missing'),
    () => client.stream('GET', '/missing'),
  ]) {
    await assert.rejects(action, {
      name: 'DockerError',
      status: 404,
      code: 'not_found',
      message: 'нет такого контейнера',
    });
  }

  await assert.rejects(() => client.hijack('/exec/stopped/start'), {
    name: 'DockerError',
    status: 409,
    code: 'conflict',
    message: 'контейнер остановлен',
  });
});

test('таймаут и отсутствующий либо недоступный демон имеют локальные коды ошибок', async (t) => {
  const { client } = await fakeEngine(t, () => {});

  await assert.rejects(() => client.request('GET', '/hang', { timeoutMs: 20 }), {
    name: 'DockerError',
    status: 504,
    code: 'docker_timeout',
  });

  const directory = await mkdtemp(join(tmpdir(), 'grigdesk-docker-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const socketPath = join(directory, 'missing.sock');
  const offline = createDockerClient({ socketPath });

  await assert.rejects(() => offline.get('/version'), {
    name: 'DockerError',
    status: 503,
    code: 'docker_unavailable',
    message: 'сокет Docker не найден — демон не запущен',
  });

  await writeFile(socketPath, '');

  await assert.rejects(() => offline.get('/version'), {
    name: 'DockerError',
    status: 503,
    code: 'docker_unavailable',
    message: 'демон Docker не принимает соединения',
  });
});

test('stream сохраняет бинарные байты, а abort закрывает длительный ответ', async (t) => {
  const bytes = Buffer.from([0, 255, 128, 10, 13]);
  const { client } = await fakeEngine(t, (request, response) => {
    response.write(bytes);

    if (request.url === '/finite') {
      response.end();
    }
  });

  const finite = await client.stream('GET', '/finite');

  assert.ok(finite.res instanceof http.IncomingMessage);
  assert.deepEqual(await readBytes(finite.res), bytes);

  const continuous = await client.stream('GET', '/continuous');
  continuous.res.on('error', () => {});

  const closed = new Promise((resolve) => continuous.res.once('close', resolve));

  continuous.abort();
  await closed;

  assert.equal(continuous.res.destroyed, true);
});

test('hijack отдаёт потребителю после await первые байты из HTTP 101 и двусторонний поток', async (t) => {
  const greeting = Buffer.from([0, 255, 128, 65]);
  const input = Buffer.from([13, 0, 254, 66]);
  const { server, client } = await fakeEngine(t);

  server.on('upgrade', (_request, socket) => {
    socket.write(Buffer.concat([
      Buffer.from('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'),
      greeting,
    ]));
    socket.on('data', (chunk) => socket.write(chunk));
  });

  const socket = await client.hijack('/exec/fake/start', { Detach: false, Tty: true });
  t.after(() => socket.destroy());

  assert.ok(socket instanceof Socket);

  const [first] = await once(socket, 'data');

  assert.deepEqual(first, greeting);

  const received = once(socket, 'data');
  socket.write(input);

  const [echo] = await received;

  assert.deepEqual(echo, input);
});

test('демультиплексор собирает разрезанные заголовки и UTF-8, разделяя stdout и stderr', () => {
  const push = createLogDemuxer();
  const frame = (stream, text) => {
    const body = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(body.length, 4);

    return Buffer.concat([header, body]);
  };

  const stdout = frame(1, 'Привет\n');
  const stderr = frame(2, 'ошибка\n');

  assert.deepEqual(push(stdout.subarray(0, 5)), []);
  assert.deepEqual(push(stdout.subarray(5, 9)), []);
  assert.deepEqual(push(Buffer.concat([stdout.subarray(9), stderr.subarray(0, 10)])), [
    { stream: 'stdout', text: 'Привет\n' },
  ]);
  assert.deepEqual(push(stderr.subarray(10)), [{ stream: 'stderr', text: 'ошибка\n' }]);
  assert.deepEqual(push(Buffer.concat([frame(1, ''), frame(2, 'следующий')])), [
    { stream: 'stdout', text: '' },
    { stream: 'stderr', text: 'следующий' },
  ]);
});
