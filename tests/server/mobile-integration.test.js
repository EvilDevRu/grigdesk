import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeContract } from '../../server/src/lib/mobile/contract.ts';
import { decodeContract as decodeApp } from '../../mobile/src/api/contract.ts';
import { decodeContract as decodeBaseline } from '../fixtures/mobile-contract/baseline/contract.ts';
import { createMobileSeed, requestMobile, advanceFactory } from '../helpers/mobileSeed.mjs';

/**
 * Устойчивая operation identity назначается до HTTP, как у настоящего native клиента.
 * Повтор команды может восстановить результат без повторного executor/решения.
 */
const command = (seed, path, body, key) =>
  requestMobile(seed, path, 'POST', body, {
    'idempotency-key': key,
    'x-grigdesk-operation-created-at': String(Date.now()),
  });

/**
 * Один живой ответ проходит серверный, независимый телефонный и замороженный v1 decoder.
 * Совместимость проверяется на реальном внутреннем API, а не обновляемой копии golden.
 */
function decodeAll(kind, value) {
  decodeContract(kind, value);
  decodeApp(kind, value);
  decodeBaseline(kind.replace(/^tracker-/u, 'b24-'), value);
}

test('MC-39: реальные auth/chat/mobile/factory/B24 и HTTPS ответы проходят v1', async (t) => {
  const seed = await createMobileSeed(t);

  assert.equal((await seed.core.inject('/api/chat/store')).statusCode, 401);

  for (const [path, kind] of [
    ['/hello', 'hello'],
    ['/chats', 'chats'],
    ['/chats/integration-chat', 'chat'],
    ['/waiting', 'waiting'],
    ['/tasks', 'tasks'],
    ['/tasks/7', 'task'],
    ['/tasks/7/plan', 'plan'],
    ['/tracker/tasks', 'tracker-tasks'],
    ['/tracker/tasks/7', 'tracker-task'],
    ['/tracker/tasks/7/launch-options', 'launch-options'],
  ]) {
    const response = await requestMobile(seed, '/api/mobile/v1' + path);

    assert.equal(response.status, 200, JSON.stringify(response.body));
    decodeAll(kind, response.body);
  }

  const accepted = await command(
    seed,
    '/api/mobile/v1/chats/integration-chat/messages',
    {
      clientId: 'integration-send-001',
      text: 'Проверяем общий настоящий приём',
    },
    'integration-send-op-001',
  );

  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  decodeAll('accepted', accepted.body);
  await seed.waitForRuns(1);

  const permission = seed.runs[0].ask({
    tool: 'Bash',
    input: { command: 'synthetic read-only' },
  });
  let waiting;
  const deadline = Date.now() + 3000;

  while (!waiting && Date.now() < deadline) {
    const response = await requestMobile(seed, '/api/mobile/v1/waiting');

    waiting = response.body.items.find((item) => item.chatId === 'integration-chat');
  }

  assert.ok(waiting);

  const answer = await command(
    seed,
    '/api/mobile/v1/waiting/' + waiting.pid,
    {
      decision: 'allow',
      comment: '',
      actionToken: waiting.actionToken,
    },
    'integration-permission-op-001',
  );

  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  decodeAll('waiting-result', answer.body);
  assert.equal((await permission).allow, true);
  seed.runs[0].release('Итог сохранён без браузера');
  await seed.core.mobileChat.reconcile('integration-chat');

  const delivery = await requestMobile(
    seed,
    '/api/mobile/v1/chats/integration-chat/deliveries?ids=integration-send-001',
  );

  decodeAll('deliveries', delivery.body);

  const task = await requestMobile(seed, '/api/mobile/v1/tasks/7');

  await advanceFactory(seed);

  const stale = await command(
    seed,
    '/api/mobile/v1/tasks/7/resume',
    {
      actionToken: task.body.task.actions.resume,
    },
    'integration-stale-op-001',
  );

  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error, 'state_changed');
});
