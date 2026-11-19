import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import test from 'node:test';

import { createWorkIpc } from '../../server/src/lib/executors/workIpc.ts';

const descriptors = [{ name: 'echo', inputSchema: { type: 'object' } }];

/**
 * Отправляет один запрос через настоящий Unix-сокет с обычным half-close клиента.
 * Ответ разбирается после закрытия, как в helper-е work-mcp.
 */
function request(ipc, input) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(ipc.socketPath);
    let output = '';

    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.end(JSON.stringify({ nonce: ipc.nonce, ...input }));
    });
    socket.on('data', (chunk) => {
      output += chunk;
    });
    socket.once('error', reject);
    socket.once('close', () => {
      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(error);
      }
    });
  });
}

test('work IPC сохраняет ответы, ошибки инструмента и проверку nonce', { timeout: 5000 }, async (t) => {
  const calls = [];
  const ipc = await createWorkIpc({
    workTools: {
      descriptors,
      async invoke(name, input) {
        calls.push({ name, input });

        if (input.fail) {
          throw new Error('инструмент недоступен');
        }

        return input;
      },
    },
  });

  t.after(() => ipc.close());

  assert.deepEqual(await request(ipc, { type: 'descriptors' }), { result: descriptors });
  assert.deepEqual(await request(ipc, { name: 'echo', input: { text: 'ответ' } }), {
    result: { text: 'ответ' },
  });
  assert.deepEqual(await request(ipc, { name: 'echo', input: { fail: true } }), {
    error: 'инструмент недоступен',
  });
  assert.deepEqual(await request(ipc, { nonce: 'wrong', name: 'echo' }), {
    error: 'work IPC nonce не совпал',
  });
  assert.equal(calls.length, 2);
});

for (const fail of [false, true]) {
  const outcome = fail ? 'ошибкой' : 'результатом';

  test(`work IPC переживает отключение клиента перед ${outcome}`, { timeout: 5000 }, async (t) => {
    const entered = Promise.withResolvers();
    const result = Promise.withResolvers();
    const completed = Promise.withResolvers();
    let calls = 0;
    const ipc = await createWorkIpc({
      workTools: {
        descriptors,
        async invoke(name, input) {
          calls += 1;
          entered.resolve({ name, input });

          try {
            return await result.promise;
          } finally {
            completed.resolve();
          }
        },
      },
    });
    const socket = createConnection(ipc.socketPath);

    t.after(async () => {
      result.resolve({});
      socket.destroy();
      await ipc.close();
    });

    await once(socket, 'connect');
    socket.end(JSON.stringify({
      nonce: ipc.nonce,
      name: 'echo',
      input: { text: 'запрос' },
    }));

    assert.deepEqual(await entered.promise, { name: 'echo', input: { text: 'запрос' } });

    const closed = once(socket, 'close');

    socket.destroy();
    await closed;

    if (fail) {
      result.reject(new Error('поздняя ошибка инструмента'));
    } else {
      result.resolve({ text: 'поздний ответ' });
    }

    await completed.promise;

    assert.deepEqual(await request(ipc, { type: 'descriptors' }), { result: descriptors });
    assert.equal(calls, 1, 'обрыв не должен повторять уже начатую операцию');
  });
}

test('work IPC переживает обрыв во время передачи большого ответа', { timeout: 5000 }, async (t) => {
  const ipc = await createWorkIpc({
    workTools: {
      descriptors,
      invoke: async () => 'x'.repeat(4 * 1024 * 1024),
    },
  });
  const socket = createConnection(ipc.socketPath);

  t.after(async () => {
    socket.destroy();
    await ipc.close();
  });

  socket.once('data', () => socket.destroy());

  await once(socket, 'connect');
  socket.end(JSON.stringify({ nonce: ipc.nonce, name: 'echo' }));
  await once(socket, 'close');

  assert.deepEqual(await request(ipc, { type: 'descriptors' }), { result: descriptors });
});
