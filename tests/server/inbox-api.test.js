import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { readFile } from 'node:fs/promises';

import inboxModule from '../../server/src/modules/inbox/index.ts';
import { encodeInboxRef, INBOX_REF_LIMITS } from '../../server/src/lib/inbox/identity.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t, {
  enabled = true,
  coordinatorOver = {},
  taskServiceOver = {},
  sseBroadcast = null,
  workerOver = {},
  fastifyOptions = {},
} = {}) {
  const calls = {
    list: [],
    summary: [],
    status: 0,
    activate: [],
    deactivate: [],
    task: [],
    dismiss: [],
    reset: [],
  };
  const events = [];
  const coordinator = {
    async list(options) {
      calls.list.push(options);
      return { items: [], channels: [], errors: [], truncated: false, limit: options.limit || 200 };
    },
    async summary(options) {
      calls.summary.push(options);
      return {
        newCount: 0, mixedCount: 0, reviewCount: 0, channels: [], errors: [], truncated: false,
      };
    },
    async status() {
      calls.status += 1;
      return { channels: [], errors: [] };
    },
    async activate(channel, body) {
      calls.activate.push({ channel, body });
      return { channel: { id: channel, label: 'GitHub' }, activation: { participation: 'active' } };
    },
    async deactivate(channel, body) {
      calls.deactivate.push({ channel, body });
      return { channel: { id: channel, label: 'GitHub' }, activation: { participation: 'deactivated' } };
    },
    ...coordinatorOver,
  };
  const taskService = {
    async task(ref, body) {
      calls.task.push({ ref, body });
      return { taskId: '5150', taskUrl: '', decision: {}, skipped: [], item: null };
    },
    async dismiss(ref, body) {
      calls.dismiss.push({ ref, body });
      return { decision: {}, item: null };
    },
    async reset(ref, body) {
      calls.reset.push({ ref, body });
      return { decision: null, item: null };
    },
    ...taskServiceOver,
  };
  const app = Fastify({ logger: false, ...fastifyOptions });
  app.decorate('pluginEnabled', (id) => id === 'inbox' && enabled);
  app.decorate('sse', {
    broadcast: sseBroadcast || ((name, payload) => events.push({ name, payload })),
  });
  app.register(inboxModule, {
    coordinator,
    taskService,
    worker: {
      status: () => ({ running: true }),
      publicStatus: async () => ({ running: true, readiness: 'ready' }),
      ...workerOver,
    },
  });
  await app.ready();
  t.after(() => app.close());
  return { app, calls, events };
}

test('plugin gate возвращает 404 до любого чтения или side effect', async (t) => {
  const { app, calls, events } = await fixture(t, { enabled: false });
  const requests = [
    ['GET', '/api/inbox'],
    ['GET', '/api/inbox/summary'],
    ['GET', '/api/inbox/status'],
    ['POST', '/api/inbox/channels/github/activate', { activationVersion: 0 }],
    ['POST', '/api/inbox/channels/github/deactivate', { activationVersion: 1 }],
    ['POST', '/api/inbox/items/item-ref/task', { revision: 'x', messageRefs: ['m'] }],
    ['POST', '/api/inbox/items/item-ref/dismiss', { revision: 'x', messageRefs: ['m'] }],
    ['POST', '/api/inbox/items/item-ref/reset', {
      revision: 'x', messageRefs: ['m'], decisionId: 'd', decisionVersion: 1,
    }],
  ];
  for (const [method, url, payload] of requests) {
    const response = await app.inject({ method, url, payload });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, 'plugin_disabled');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(calls, {
    list: [], summary: [], status: 0, activate: [], deactivate: [], task: [], dismiss: [], reset: [],
  });
  assert.deepEqual(events, []);
});

test('read routes передают limit, добавляют worker status и запрещают cache', async (t) => {
  const { app, calls } = await fixture(t);
  const listed = await app.inject({ method: 'GET', url: '/api/inbox?limit=17' });
  const summary = await app.inject({ method: 'GET', url: '/api/inbox/summary?limit=9' });
  const status = await app.inject({ method: 'GET', url: '/api/inbox/status' });

  assert.equal(listed.statusCode, 200);
  assert.equal(listed.headers['cache-control'], 'no-store');
  assert.equal(listed.json().limit, 17);
  assert.deepEqual(listed.json().worker, { running: true, readiness: 'ready' });
  assert.deepEqual(calls.list, [{ limit: 17 }]);
  assert.deepEqual(calls.summary, [{ limit: 9 }]);
  assert.equal(summary.json().reviewCount, 0);
  assert.equal(calls.status, 1);
  assert.deepEqual(status.json().worker, { running: true, readiness: 'ready' });
});

test('activate/deactivate публикуют inbox-changed только после успешного commit', async (t) => {
  let failDeactivate = false;
  const { app, calls, events } = await fixture(t, {
    coordinatorOver: {
      async deactivate(channel, body) {
        calls.deactivate.push({ channel, body });
        if (failDeactivate) {
          throw Object.assign(new Error('provider token secret'), {
            code: 'channel_disconnected',
            statusCode: 409,
          });
        }
        return { channel: { id: channel }, activation: { participation: 'deactivated' } };
      },
    },
  });

  const active = await app.inject({
    method: 'POST',
    url: '/api/inbox/channels/github/activate',
    payload: { activationVersion: 0 },
  });
  const inactive = await app.inject({
    method: 'POST',
    url: '/api/inbox/channels/github/deactivate',
    payload: { activationVersion: 1 },
  });
  failDeactivate = true;
  const failed = await app.inject({
    method: 'POST',
    url: '/api/inbox/channels/github/deactivate',
    payload: { activationVersion: 2 },
  });

  assert.equal(active.statusCode, 200);
  assert.equal(inactive.statusCode, 200);
  assert.equal(failed.statusCode, 409);
  assert.equal(failed.json().error, 'channel_disconnected');
  assert.ok(!failed.body.includes('provider token secret'));
  assert.deepEqual(calls.activate, [{ channel: 'github', body: { activationVersion: 0 } }]);
  assert.deepEqual(calls.deactivate, [
    { channel: 'github', body: { activationVersion: 1 } },
    { channel: 'github', body: { activationVersion: 2 } },
  ]);
  assert.deepEqual(events, [
    {
      name: 'inbox-changed',
      payload: { itemRef: null, channel: 'github', status: 'activated', taskId: null },
    },
    {
      name: 'inbox-changed',
      payload: { itemRef: null, channel: 'github', status: 'deactivated', taskId: null },
    },
  ]);

  const brokenSse = await fixture(t, {
    sseBroadcast() { throw new Error('sse unavailable'); },
  });
  const committed = await brokenSse.app.inject({
    method: 'POST',
    url: '/api/inbox/channels/github/activate',
    payload: { activationVersion: 0 },
  });
  assert.equal(committed.statusCode, 200, 'ошибка SSE не отменяет уже выполненную activation');
});

test('item actions делегируются без преобразования opaque ref и body', async (t) => {
  const { app, calls } = await fixture(t);
  const body = { revision: 'revision', messageRefs: ['message-ref'] };
  const resetBody = { ...body, decisionId: 'decision', decisionVersion: 2 };
  const encodedRef = encodeURIComponent('opaque/item+ref');

  assert.equal((await app.inject({
    method: 'POST', url: `/api/inbox/items/${encodedRef}/task`, payload: body,
  })).statusCode, 200);
  assert.equal((await app.inject({
    method: 'POST', url: `/api/inbox/items/${encodedRef}/dismiss`, payload: body,
  })).statusCode, 200);
  assert.equal((await app.inject({
    method: 'POST', url: `/api/inbox/items/${encodedRef}/reset`, payload: resetBody,
  })).statusCode, 200);

  assert.deepEqual(calls.task, [{ ref: 'opaque/item+ref', body }]);
  assert.deepEqual(calls.dismiss, [{ ref: 'opaque/item+ref', body }]);
  assert.deepEqual(calls.reset, [{ ref: 'opaque/item+ref', body: resetBody }]);
});

test('HTTP error mapping не отражает provider secrets и фиксирует indeterminate contract', async (t) => {
  let mode = 'b24';
  const { app } = await fixture(t, {
    taskServiceOver: {
      async task() {
        if (mode === 'b24') {
          throw Object.assign(new Error('portal token super-secret'), {
            code: 'b24_failed',
            statusCode: 502,
          });
        }
        if (mode === 'provider') {
          throw Object.assign(new Error('github token super-secret'), {
            code: 'provider_private_failure',
            statusCode: 409,
          });
        }
        if (mode === 'analysis') {
          throw Object.assign(new Error('local media path super-secret'), {
            code: 'attachment_analysis_required',
            statusCode: 409,
          });
        }
        if (mode === 'stale-generation') {
          throw Object.assign(new Error('internal generation changed'), {
            code: 'stale_generation',
            statusCode: 409,
          });
        }
        throw Object.assign(new Error('disk path super-secret'), {
          code: 'indeterminate_task_commit',
          statusCode: 503,
          details: {
            retryable: true,
            taskId: '5150',
            taskUrl: mode === 'unsafe-url'
              ? 'javascript:alert(1)'
              : 'https://b24.example/tasks/5150',
          },
        });
      },
    },
  });
  const request = () => app.inject({
    method: 'POST',
    url: '/api/inbox/items/ref/task',
    payload: { revision: 'x', messageRefs: ['m'] },
  });

  const b24 = await request();
  assert.equal(b24.statusCode, 502);
  assert.deepEqual(b24.json(), {
    error: 'b24_failed',
    message: 'Битрикс24 не принял задачу. Обращение осталось новым.',
  });
  assert.ok(!b24.body.includes('super-secret'));

  mode = 'provider';
  const provider = await request();
  assert.equal(provider.statusCode, 409);
  assert.equal(provider.json().error, 'invalid_request');
  assert.ok(!provider.body.includes('super-secret'));

  mode = 'stale-generation';
  const changedAccount = await request();
  assert.equal(changedAccount.statusCode, 409);
  assert.deepEqual(changedAccount.json(), {
    error: 'account_changed',
    message: 'Подключённый аккаунт канала изменился.',
  });
  assert.ok(!changedAccount.body.includes('generation'));

  mode = 'analysis';
  const analysis = await request();
  assert.equal(analysis.statusCode, 409);
  assert.deepEqual(analysis.json(), {
    error: 'attachment_analysis_required',
    message: 'Содержимое вложений разобрано не полностью. Опишите его, чтобы поставить задачу.',
    // Отказ обязан назвать неразобранные вложения: человеку предстоит описать
    // именно их. Без деталей сервиса список пуст, но поле остаётся в контракте.
    attachments: [],
  });
  assert.ok(!analysis.body.includes('super-secret'));

  mode = 'indeterminate';
  const uncertain = await request();
  assert.equal(uncertain.statusCode, 503);
  assert.deepEqual(uncertain.json(), {
    error: 'indeterminate_task_commit',
    message: 'B24-задача могла быть создана, но Inbox не подтвердил решение. Нужна сверка оператора.',
    retryable: false,
    taskId: '5150',
    taskUrl: 'https://b24.example/tasks/5150',
  });
  assert.ok(!uncertain.body.includes('disk path'));

  mode = 'unsafe-url';
  assert.equal((await request()).json().taskUrl, '');
});

test('список неразобранных вложений доезжает до человека, но проходит санитайз', async (t) => {
  const { app } = await fixture(t, {
    taskServiceOver: {
      async task() {
        throw Object.assign(new Error('нельзя'), {
          code: 'attachment_analysis_required',
          statusCode: 409,
          details: {
            attachments: [
              {
                label: 'видео · bug.mp4',
                reason: 'файл 53 МБ — бот не может скачать больше 20 МБ',
              },
              // Управляющие символы и переполнение схлопываются: строка рисуется
              // в модалке, а не в терминале.
              { label: `a\nb c${'x'.repeat(400)}`, reason: 'y'.repeat(400) },
              { label: '', reason: '' },
              ...Array.from({ length: 20 }, () => ({ label: 'лишнее', reason: 'лишнее' })),
            ],
          },
        });
      },
    },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/inbox/items/ref/task',
    payload: { revision: 'x', messageRefs: ['m'] },
  });

  assert.equal(response.statusCode, 409);
  const { attachments } = response.json();
  assert.equal(attachments.length, 12, 'список bounded: карточка не растягивается чужим payload');
  assert.deepEqual(attachments[0], {
    label: 'видео · bug.mp4',
    reason: 'файл 53 МБ — бот не может скачать больше 20 МБ',
  });
  // Перевод строки схлопнут в пробел: подпись рисуется одной строкой в модалке.
  assert.equal(attachments[1].label.includes('\n'), false);
  assert.ok(attachments[1].label.startsWith('a b c'));
  assert.ok(attachments[1].label.length <= 200);
  assert.ok(attachments[1].reason.length <= 240);
  assert.equal(attachments[2].label, 'вложение', 'пустая подпись остаётся понятной');
});

test('реалистичный item ref длиннее дефолтного :param — роутеру нужен свой maxParamLength', async (t) => {
  // Синтетический ref обычной Telegram-карточки длиннее 100 символов base64url.
  // Роутер отвечал 414 раньше обработчика, поэтому автомат работал (он ходит внутри
  // процесса), а все три ручные кнопки человека были мертвы.
  const ref = encodeInboxRef('item', {
    channel: 'telegram',
    accountRef: 'acc_00000000000000000000000000000000',
    localBundleId: Buffer.from(JSON.stringify(
      [1, 'bundle', '-1001000000042', 1, ['thread', '424242'], '43'],
    ), 'utf8').toString('base64url'),
  });
  assert.ok(ref.length > 100, `ref должен быть длиннее дефолта fastify, получено ${ref.length}`);
  assert.ok(ref.length <= INBOX_REF_LIMITS.encodedChars);

  const payload = { revision: 'rev-1', messageRefs: ['m'] };
  const defaults = await fixture(t);
  const rejected = await defaults.app.inject({
    method: 'POST', url: `/api/inbox/items/${ref}/dismiss`, payload,
  });
  assert.equal(rejected.statusCode, 414);
  assert.equal(rejected.json().code, 'FST_ERR_MAX_PARAM_LENGTH');
  assert.deepEqual(defaults.calls.dismiss, []);

  const raised = await fixture(t, {
    fastifyOptions: { maxParamLength: INBOX_REF_LIMITS.encodedChars },
  });
  const accepted = await raised.app.inject({
    method: 'POST', url: `/api/inbox/items/${ref}/dismiss`, payload,
  });
  assert.notEqual(accepted.statusCode, 414);
  assert.deepEqual(raised.calls.dismiss.map((call) => call.ref), [ref]);
});

test('боевой сервер поднимает maxParamLength до потолка кодека refs', async () => {
  // Статическая сверка: фикстура выше доказывает, что опция нужна и достаточна, но она
  // своя. Значение должно быть выражено той же константой, иначе пределов правды станет два.
  const source = await readFile(new URL('../../server/src/app.js', import.meta.url), 'utf8');
  assert.match(source, /maxParamLength:\s*INBOX_REF_LIMITS\.encodedChars/);
});
