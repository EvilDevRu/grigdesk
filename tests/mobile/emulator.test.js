import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PhoneEmulator, startEmulator } from '../../tools/mobile-phone/emulator.mts';
import { allowedRequest } from '../../tools/mobile-phone/routes.mts';
import { localStack } from './helpers/local-stack.js';
import { parseQr } from '../../mobile/src/link/qr.ts';

/**
 * Ключ эмулятора принадлежит только этому тесту и удаляется после закрытия всех сокетов.
 * Ни параметры, ни сертификаты живого Кокпита тест не использует.
 */
async function phoneFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cockpit-phone-'));
  const phone = new PhoneEmulator(directory);

  t.after(async () => {
    phone.lock();
    await rm(directory, {
      recursive: true,
      force: true,
    });
  });

  return phone;
}

test('MV-01/02/04: два pinned TLS, реальный pair/чат/SSE и защищённый dev API', async (t) => {
  const stack = await localStack(t);
  const phone = await phoneFixture(t);
  const events = [];

  phone.subscribe((name, value) => {
    events.push({
      name,
      value,
    });
  });
  await phone.addFromText(stack.qr);

  const hello = JSON.parse(
    (
      await phone.request({
        method: 'GET',
        path: '/api/mobile/v1/hello',
      })
    ).body,
  );

  assert.equal(hello.api, 1);
  assert.equal(hello.device.id, phone.state.deviceId);
  assert.equal(hello.device.name, 'Эмулятор телефона');
  assert.equal(
    (await stack.service.devices.list()).filter((item) => item.name === 'Эмулятор телефона').length,
    1,
  );

  const response = await phone.request({
    method: 'POST',
    path: '/api/mobile/v1/chats/integration-chat/messages',
    body: JSON.stringify({
      clientId: 'emulator-turn-001',
      text: 'Из эмулятора через посредника',
    }),
    idempotencyKey: 'emulator-turn-operation-001',
    createdAt: Date.now(),
  });

  assert.equal(response.status, 202, response.body);
  await stack.waitForRuns(1);
  phone.startEvents();

  const deadline = Date.now() + 3000;

  while (!events.some((event) => event.name === 'linkEvent' && event.value.name === 'ready')) {
    assert.equal(Date.now() < deadline, true, 'Нет ready через сквозной TLS');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  stack.runs[0].release('Настоящий ответ через посредника');
  await stack.core.mobileChat.reconcile('integration-chat');

  const chat = JSON.parse(
    (
      await phone.request({
        method: 'GET',
        path: '/api/mobile/v1/chats/integration-chat',
      })
    ).body,
  );

  assert.equal(
    chat.messages.filter((message) => message.clientId === 'emulator-turn-001').length >= 1,
    true,
  );

  const api = await startEmulator(phone);

  t.after(() => api.close());
  assert.equal((await fetch(`http://127.0.0.1:${api.port}/link/state`)).status, 401);
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${api.port}/link/request`, {
        method: 'POST',
        headers: { 'X-Emulator-Token': api.token },
        body: JSON.stringify({
          method: 'GET',
          path: '/api/chat/store',
        }),
      })
    ).status,
    400,
  );
  await assert.rejects(
    phone.request({
      method: 'GET',
      path: '/api/chat/store',
    }),
    /bad_route/,
  );
  phone.lock();
  assert.equal(phone.getState().unlocked, false);
  await assert.rejects(
    phone.request({
      method: 'GET',
      path: '/api/mobile/v1/chats',
    }),
    /locked/,
  );
});

test('MV-02: allowlist исключает чужие URL, traversal и специальные ручки', () => {
  for (const url of [
    'https://localhost/api/mobile/v1/chats',
    '/api/mobile/v1/../chat/store',
    '/api/mobile/v1/chats/%252f',
    '/api/mobile/v1/chats/%2f',
    '/api/mobile/v1/pair',
    '/api/mobile/v1/events',
    '/api/mobile/v1/app/apk',
    '/api/mobile/v1/chats/a/media/u:x.png',
  ]) {
    assert.equal(allowedRequest('GET', url), false, url);
  }

  assert.equal(allowedRequest('DELETE', '/api/mobile/v1/chats'), false);
  assert.equal(allowedRequest('GET', '/api/mobile/v1/chats/abc?before=1&revision=2'), true);
  assert.equal(allowedRequest('POST', '/api/mobile/v1/tasks/7/gate'), true);
  assert.equal(allowedRequest('GET', '/api/mobile/v1/chat-options'), true);
  assert.equal(allowedRequest('GET', '/api/mobile/v1/attention'), true);
  assert.equal(allowedRequest('POST', '/api/mobile/v1/chats'), true);
  assert.equal(allowedRequest('POST', '/api/mobile/v1/chats/abc/settings'), true);
  assert.equal(allowedRequest('POST', '/api/mobile/v1/chats/abc/read'), true);
  assert.equal(allowedRequest('POST', '/api/mobile/v1/chats/abc/workspace/preview'), true);
  assert.equal(allowedRequest('POST', '/api/mobile/v1/chats/abc/workspace'), true);
  assert.equal(allowedRequest('POST', '/api/mobile/v1/chats/abc/workspace?path=/tmp'), false);
  assert.equal(allowedRequest('POST', '/api/mobile/v1/chats/abc/settings/extra'), false);
  assert.equal(allowedRequest('POST', '/api/chat/workdir/change'), false);
});

test('MV-12: brain_offline остаётся сетевой ошибкой, durable сообщение ждёт восстановления', async (t) => {
  const stack = await localStack(t);
  const phone = await phoneFixture(t);

  await phone.addFromText(stack.qr);

  const bridge = await startEmulator(phone);
  const item = {
    method: 'POST',
    path: '/api/mobile/v1/chats/integration-chat/messages',
    body: JSON.stringify({
      text: 'Жду сеть',
      clientId: 'offline-client-001',
    }),
    chatId: 'integration-chat',
    clientId: 'offline-client-001',
    idempotencyKey: 'offline-operation-001',
    createdAt: Date.now(),
  };

  t.after(() => bridge.close());
  await stack.service.close();

  const response = await fetch(`http://127.0.0.1:${bridge.port}/link/request`, {
    method: 'POST',
    headers: { 'X-Emulator-Token': bridge.token },
    body: JSON.stringify(item),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.body), { error: 'network' });
  assert.deepEqual(phone.getOutbox().items, [item]);
  assert.equal(phone.getState().unlocked, true);
});

/**
 * Читает dev SSE эмулятора до кадра ready или до срока и закрывает свой поток.
 * Возвращает признак, что вкладка узнала об уже открытой связи с мозгом.
 */
async function readyFrame(bridge, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = '';

  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/link/events`, {
      headers: { 'X-Emulator-Token': bridge.token },
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (!/event: linkEvent\ndata: .*"name":"ready"/.test(text)) {
      const chunk = await reader.read();

      if (chunk.done) {
        return false;
      }

      text += decoder.decode(chunk.value, { stream: true });
    }

    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

test('MV-04: новая вкладка DevLink получает ready уже открытого потока', async (t) => {
  const stack = await localStack(t);
  const phone = await phoneFixture(t);

  await phone.addFromText(stack.qr);

  const bridge = await startEmulator(phone);

  t.after(() => bridge.close());
  assert.equal(await readyFrame(bridge, 5000), true, 'первая вкладка не получила ready');
  assert.equal(phone.diagnostics().eventsWanted, true);
  assert.equal(await readyFrame(bridge, 3000), true, 'перезагруженная вкладка осталась «Нет связи»');
});

test('MV-03/04: повреждённая сохранённая очередь и неверный brain pin закрывают доступ', async (t) => {
  const stack = await localStack(t);
  const phone = await phoneFixture(t);
  const qr = parseQr(stack.qr);

  qr.brain.fp = '0'.repeat(64);
  await assert.rejects(
    phone.addFromText('cockpitlink:1:' + Buffer.from(JSON.stringify(qr)).toString('base64url')),
    /brain_pin_mismatch/,
  );
  assert.equal(phone.getState().unlocked, false);
  assert.equal(phone.diagnostics().sockets, 0);

  await writeFile(
    path.join(phone.directory, 'outbox.json'),
    JSON.stringify([
      {
        method: 'GET',
        path: '/api/mobile/v1/chats',
        body: '{}',
        idempotencyKey: 'invalid-read-operation',
        createdAt: Date.now(),
      },
    ]),
  );

  const replacement = new PhoneEmulator(phone.directory);

  await assert.rejects(replacement.load(), /store_corrupt/);
  assert.equal(replacement.getState().unlocked, false);

  const other = await phoneFixture(t);
  const relayQr = parseQr(stack.qr);

  relayQr.relay.fp = '0'.repeat(64);
  await assert.rejects(
    other.addFromText(
      'cockpitlink:1:' + Buffer.from(JSON.stringify(relayQr)).toString('base64url'),
    ),
    /relay_pin_mismatch/,
  );
  assert.equal(other.getState().unlocked, false);
  assert.equal(other.diagnostics().sockets, 0);
});
