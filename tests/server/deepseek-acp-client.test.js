import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createAcpClient,
  initializeAcp,
} from '../../server/src/lib/acp/client.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_ACP = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/fakeAcp.mts');

class FakeChild extends EventEmitter {
  stdout = new PassThrough();

  stdin = new PassThrough();

  killedWith = [];

  kill(signal) {
    this.killedWith.push(signal);
    return true;
  }
}

function frame(value) {
  return `${JSON.stringify(value)}\n`;
}

async function turn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('клиент собирает UTF-8/chunks, несколько frames и ответы не по порядку', async () => {
  const child = new FakeChild();
  const notifications = [];
  const client = createAcpClient(child, {
    onNotification(method, params) { notifications.push([method, params]); },
  });
  const first = client.request('initialize');
  const second = client.request('session/new');

  child.stdout.write(frame({ jsonrpc: '2.0', id: 2, result: { order: 2 } }));
  const utf8 = Buffer.from(frame({ jsonrpc: '2.0', id: 1, result: { text: 'ёж' } }));
  const split = utf8.indexOf(Buffer.from('ж')) + 1;
  child.stdout.write(utf8.subarray(0, split));
  child.stdout.write(Buffer.concat([
    utf8.subarray(split),
    Buffer.from(frame({ jsonrpc: '2.0', method: 'session/update', params: { n: 1 } })),
    Buffer.from(frame({ jsonrpc: '2.0', method: 'session/update', params: { n: 2 } })),
  ]));

  assert.deepEqual(await second, { order: 2 });
  assert.deepEqual(await first, { text: 'ёж' });
  await turn();
  assert.deepEqual(notifications, [
    ['session/update', { n: 1 }],
    ['session/update', { n: 2 }],
  ]);
  client.close();
});

test('reverse request не блокирует notifications и EOF отклоняет pending до ответа человека', async () => {
  const child = new FakeChild();
  let resolvePermission;
  const permission = new Promise((resolve) => { resolvePermission = resolve; });
  const notifications = [];
  const writes = [];
  child.stdin.on('data', (chunk) => writes.push(String(chunk)));
  const client = createAcpClient(child, {
    onNotification(method) { notifications.push(method); },
    onReverseRequest() { return permission; },
  });
  const pending = client.request('session/prompt');

  child.stdout.write(
    frame({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: {} })
    + frame({ jsonrpc: '2.0', method: 'session/update', params: { update: 'still-live' } }),
  );
  await turn();
  assert.deepEqual(notifications, ['session/update']);
  child.stdout.end();
  await assert.rejects(pending, /ACP transport завершился/);

  const before = writes.join('');
  resolvePermission({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  await turn();
  assert.equal(writes.join(''), before, 'поздний allow не отправлен после EOF');
});

test('неизвестный reverse method получает JSON-RPC error, соединение остаётся живо', async () => {
  const child = new FakeChild();
  const writes = [];
  child.stdin.on('data', (chunk) => writes.push(String(chunk)));
  const client = createAcpClient(child, {
    onReverseRequest(method) {
      if (method !== 'session/request_permission') throw new Error(`Неизвестный reverse method: ${method}`);
      return {};
    },
  });

  child.stdout.write(frame({ jsonrpc: '2.0', id: 90, method: 'unknown/reverse', params: {} }));
  await turn();
  const response = writes.flatMap((chunk) => chunk.trim().split('\n')).map(JSON.parse)
    .find((entry) => entry.id === 90);
  assert.equal(response.error.code, -32603);

  const request = client.request('initialize');
  child.stdout.write(frame({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  assert.deepEqual(await request, { ok: true });
  client.close();
});

test('oversize frame закрывает transport, убивает child и чистит listeners/timers', async () => {
  const child = new FakeChild();
  const client = createAcpClient(child, { maxLineBytes: 32, requestTimeoutMs: 60_000 });
  const pending = client.request('initialize');
  child.stdout.write(Buffer.alloc(33, 0x78));

  await assert.rejects(pending, /превысила лимит/);
  assert.deepEqual(child.killedWith, ['SIGTERM']);
  assert.equal(client.closed, true);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stdout.listenerCount('end'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('close снимает listeners и отклоняет незавершённые запросы', async () => {
  const child = new FakeChild();
  const client = createAcpClient(child, { requestTimeoutMs: 60_000 });
  const pending = client.request('initialize');
  client.close();

  await assert.rejects(pending, /ACP client закрыт/);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stdout.listenerCount('end'), 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('exit ACP закрывает pending, даже если унаследованный stdout остаётся открыт', async () => {
  const child = new FakeChild();
  const client = createAcpClient(child, { requestTimeoutMs: 60_000 });
  const pending = client.request('session/prompt');

  child.emit('exit', null, 'SIGTERM');

  await assert.rejects(pending, /ACP process завершился \(SIGTERM\)/u);
  assert.equal(client.closed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stdin.destroyed, true);
});

test('исполняемый fake ACP реализует реальный lifecycle и пишет журнал', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-fake-acp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake.ndjson');
  await fs.writeFile(scenarioFile, JSON.stringify({
    configOptions: [{ id: 'model', currentValue: 'opaque-model' }],
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } }],
  }));
  const child = spawn(process.execPath, [FAKE_ACP, '--scenario', scenarioFile, '--log', logFile], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const updates = [];
  const client = createAcpClient(child, {
    onNotification(method, params) { if (method === 'session/update') updates.push(params); },
  });

  await initializeAcp(client);
  const session = await client.request('session/new', { cwd: root, mcpServers: [] });
  const result = await client.request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'ping' }],
  });
  assert.deepEqual(result, { stopReason: 'end_turn' });
  assert.equal(updates.length, 1);
  await client.request('session/close', { sessionId: session.sessionId });
  client.close();
  if (child.exitCode === null) await once(child, 'close');

  const methods = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter((entry) => entry.kind === 'request' && entry.message.method)
    .map((entry) => entry.message.method);
  assert.deepEqual(methods, ['initialize', 'session/new', 'session/prompt', 'session/close']);
});
