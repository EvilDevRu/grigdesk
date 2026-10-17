import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InboxContractError,
  parseInboxActivation,
  parseInboxBlockedAttachments,
  parseInboxDecisionResult,
  parseInboxList,
  parseInboxSummary,
} from '../../shared/inbox/inboxContracts.ts';
import { api } from '../../web/src/shared/apiClient.ts';
import { inboxApi, inboxBlockedAttachments, inboxPluginDisabled } from '../../web/src/shared/inboxApi.ts';

const MESSAGE = {
  messageRef: 'inbox1:message:...',
  occurredAt: 1_757_318_400,
  editedAt: null,
  author: { name: 'Соседний отдел' },
  text: 'Отчёт не сходится с выгрузкой',
  attachments: [],
  decision: null,
};
const ITEM = {
  ref: 'inbox1:item:...',
  revision: 'rev-1',
  channel: { id: 'telegram', label: 'Телеграм' },
  source: { title: 'Общий чат', url: null },
  project: null,
  kind: null,
  status: 'new',
  decision: null,
  firstAt: 1_757_318_400,
  lastAt: 1_757_318_460,
  cold: true,
  autoTask: { enabled: false, readyAtMs: 0 },
  title: null,
  description: null,
  truncated: null,
  messages: [MESSAGE],
  attachments: [],
};
const CHANNEL = {
  id: 'telegram',
  label: 'Телеграм',
  plugin: 'enabled',
  connection: 'connected',
  participation: 'active',
  activationVersion: 3,
  currentEpoch: 2,
  startedAtMs: 1_757_318_400_000,
  endedAtMs: null,
  endReason: null,
  reason: null,
  readOnly: false,
  truncated: false,
};

const listPayload = (extra = {}) => ({
  items: [ITEM],
  channels: [CHANNEL],
  errors: [],
  truncated: false,
  worker: null,
  ...extra,
});

test('карточка не выносит наружу нативный payload канала и его учётные данные', () => {
  const list = parseInboxList(listPayload({
    items: [{ ...ITEM, accountRef: 'acc-1', native: { chat_id: 42 }, token: 'секрет' }],
  }));

  assert.deepEqual(list.items, [ITEM]);
  assert.equal(JSON.stringify(list).includes('chat_id'), false);
  assert.equal(JSON.stringify(list).includes('секрет'), false);
});

test('состояние карточки и участие канала закрыты перечислениями', () => {
  assert.throws(
    () => parseInboxList(listPayload({ items: [{ ...ITEM, status: 'разобрано' }] })),
    /inboxList\.items\[0\]\.status/,
  );
  assert.throws(
    () => parseInboxList(listPayload({ channels: [{ ...CHANNEL, participation: 'inactive' }] })),
    /inboxList\.channels\[0\]\.participation/,
  );
  assert.throws(
    () => parseInboxList(listPayload({ channels: [{ ...CHANNEL, connection: 'думает' }] })),
    /inboxList\.channels\[0\]\.connection/,
  );
});

test('ревизия карточки и версия решения проверяются строго — на них блокировка', () => {
  assert.throws(
    () => parseInboxList(listPayload({ items: [{ ...ITEM, revision: 7 }] })),
    /inboxList\.items\[0\]\.revision/,
  );
  assert.throws(
    () => parseInboxList(listPayload({ channels: [{ ...CHANNEL, activationVersion: '3' }] })),
    /inboxList\.channels\[0\]\.activationVersion/,
  );

  const decided = parseInboxList(listPayload({
    items: [{
      ...ITEM,
      status: 'task',
      decision: {
        decisionId: 'd-1',
        version: 2,
        status: 'task',
        taskId: '1042',
        taskUrl: 'https://example.invalid/1042',
        by: 'human',
        note: null,
        decidedAtMs: 1_757_318_500_000,
      },
    }],
  }));

  assert.equal(decided.items[0].decision.version, 2);
});

test('ход разбора вложения приходит и строкой, и объектом', () => {
  const [byString, byObject] = parseInboxList(listPayload({
    items: [
      {
        ...ITEM,
        attachments: [{ kind: 'voice', displayLabel: 'Голос', attachmentAnalysis: 'processing' }],
      },
      {
        ...ITEM,
        ref: 'inbox1:item:второй',
        attachments: [{ kind: 'voice', attachmentAnalysis: { status: 'done', transcript: 'текст' } }],
      },
    ],
  })).items;

  assert.equal(byString.attachments[0].attachmentAnalysis, 'processing');
  assert.deepEqual(byObject.attachments[0].attachmentAnalysis, {
    status: 'done',
    transcript: 'текст',
    text: null,
  });
});

test('сводка различает очередь человека и созревшее для автомата', () => {
  const summary = parseInboxSummary({
    newCount: 4,
    mixedCount: 1,
    reviewCount: 5,
    truncated: false,
  });

  assert.deepEqual({ review: summary.reviewCount, fresh: summary.newCount }, { review: 5, fresh: 4 });
  assert.equal(summary.channels, null, 'разбор по каналам приходит не всегда');
  assert.throws(
    () => parseInboxSummary({ newCount: -1, mixedCount: 0, truncated: false }),
    /inboxSummary\.newCount/,
  );
});

test('неудачный ответ в чат не отменяет уже созданную задачу', () => {
  const result = parseInboxDecisionResult({
    decision: { decisionId: 'd-1', version: 1 },
    taskId: '1042',
    taskUrl: 'https://example.invalid/1042',
    notification: { enabled: true, sent: false, reason: 'chat_closed' },
  });

  assert.deepEqual(result.notification, { enabled: true, sent: false, reason: 'chat_closed' });
  assert.equal(result.taskId, '1042');
  assert.equal(result.item, null);
});

test('исход участия канала переживает короткий ответ сервера', () => {
  assert.deepEqual(parseInboxActivation({ channel: 'telegram', activationVersion: 4 }), {
    channel: 'telegram',
    activationVersion: 4,
    participation: null,
  });
  assert.throws(
    () => parseInboxActivation({ participation: 'inactive' }),
    InboxContractError,
  );
});

test('вложения из тела отказа доезжают до модалки, а мусор — нет', () => {
  assert.deepEqual(
    inboxBlockedAttachments({ data: { attachments: [{ label: 'Голос', reason: 'файл больше предела бота' }] } }),
    [{ label: 'Голос', reason: 'файл больше предела бота' }],
  );
  assert.deepEqual(parseInboxBlockedAttachments(null), []);
  assert.deepEqual(parseInboxBlockedAttachments('нет'), []);
});

test('выключенный плагин отличается от поломки сети', () => {
  assert.equal(inboxPluginDisabled({ status: 404, data: { error: 'plugin_disabled' } }), true);
  assert.equal(inboxPluginDisabled({ status: 404, data: { error: 'not_found' } }), false);
  assert.equal(inboxPluginDisabled({ status: 500 }), false);
});

test('адаптер кодирует ссылки карточек и подтверждает форму каждого ответа', async (t) => {
  const seen = [];

  t.mock.method(api, 'get', async (url) => {
    seen.push(['GET', url]);

    return url.endsWith('/summary')
      ? { newCount: 0, mixedCount: 0, truncated: false }
      : listPayload();
  });
  t.mock.method(api, 'post', async (url) => {
    seen.push(['POST', url]);

    return { decision: { decisionId: 'd-1', version: 1 } };
  });

  await inboxApi.list();
  await inboxApi.summary();
  await inboxApi.decide('inbox1:item:а/б', 'task', { revision: 'rev-1' });

  const ref = encodeURIComponent('inbox1:item:а/б');

  assert.deepEqual(seen, [
    ['GET', '/api/inbox'],
    ['GET', '/api/inbox/summary'],
    ['POST', `/api/inbox/items/${ref}/task`],
  ]);
});

test('повреждённый ответ сети не становится карточкой на экране', async (t) => {
  t.mock.method(api, 'get', async () => listPayload({ items: [{ ...ITEM, firstAt: 'вчера' }] }));

  await assert.rejects(inboxApi.list(), InboxContractError);
});
