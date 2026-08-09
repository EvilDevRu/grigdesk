import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const {
  buildInboxDraft,
  inboxTranscript,
  safeInboxSourceUrl,
} = await import('../../server/src/lib/inbox/draft.js');

const T0 = Date.UTC(2026, 7, 7, 10, 0, 0) / 1000;
const message = (over = {}) => ({
  schema: 1,
  channel: 'github',
  accountRef: 'acc_draft_000000001',
  source: { id: 'repo:1', title: 'Issues', threadId: '42' },
  id: '42',
  parentId: null,
  groupId: null,
  occurredAt: T0,
  editedAt: null,
  author: { id: 'user:1', name: 'Пользователь' },
  text: '',
  attachments: [],
  service: false,
  ...over,
});

test('generic title/transcript используют только normalized presentation fields', () => {
  const messages = [
    message({
      id: '1',
      attachments: [{
        ref: 'opaque-secret-ref', dedupeKey: 'opaque-secret-key', kind: 'image',
        displayLabel: 'скриншот', name: 'ошибка.png', size: 42,
      }],
    }),
    message({ id: '2', occurredAt: T0 + 60, text: 'Баг / Форма не сохраняется' }),
  ];
  const draft = buildInboxDraft({ messages, source: messages[0].source }, {
    kind: 'bug',
    channelLabel: 'GitHub Issues',
    sourceUrl: 'https://github.com/example/repo/issues/42',
  });

  assert.equal(draft.title, 'Форма не сохраняется');
  assert.equal(draft.description.split('\n')[0], '[07.08.2026 10:00] Пользователь: (скриншот ошибка.png)');
  assert.ok(draft.description.endsWith('Источник · GitHub Issues: https://github.com/example/repo/issues/42'));
  assert.ok(!draft.description.includes('opaque-secret'));
});

test('attachments дедуплицируются по server-only dedupeKey, но остаются internal', () => {
  const attachment = {
    ref: 'opaque-1', dedupeKey: 'same', kind: 'document',
    displayLabel: 'файл', name: 'лог.txt', size: 100,
  };
  const messages = [
    message({ id: '1', attachments: [attachment] }),
    message({ id: '2', occurredAt: T0 + 1, attachments: [{ ...attachment, ref: 'opaque-2' }] }),
  ];
  const draft = buildInboxDraft({ messages, source: messages[0].source });
  assert.equal(draft.attachments.length, 1);
  assert.deepEqual(draft.attachments[0], {
    ...attachment,
    messageId: '1',
    groupId: null,
  });
});

test('пустой текст получает generic fallback по kind/author/date', () => {
  const messages = [message()];
  assert.equal(
    buildInboxDraft({ messages }, { kind: 'wish' }).title,
    'Идея · Пользователь · 07.08.2026',
  );
  assert.equal(
    buildInboxDraft({ messages }, { kind: 'support' }).title,
    'Обращение · Пользователь · 07.08.2026',
  );
});

test('transcript исключает service и честно обозначает truncation', () => {
  const messages = [
    message({ id: 'service', service: true, text: 'служебное' }),
    ...Array.from({ length: 20 }, (_, i) => message({
      id: String(i), occurredAt: T0 + i, text: `длинная строка ${i} `.repeat(10),
    })),
  ];
  const result = inboxTranscript(messages, { limit: 500, footer: '\nИсточник' });
  assert.equal(result.truncated, true);
  assert.match(result.text, /показаны первые \d+ из 20 сообщений/);
  assert.ok(result.text.endsWith('Источник'));
  assert.ok(!result.text.includes('служебное'));
});

test('source URL допускает только абсолютный http(s) без credentials', () => {
  assert.equal(safeInboxSourceUrl('https://example.test/path'), 'https://example.test/path');
  assert.equal(safeInboxSourceUrl(null), null);
  assert.throws(() => safeInboxSourceUrl('javascript:alert(1)'), /небезопасную схему/);
  assert.throws(() => safeInboxSourceUrl('https://token@example.test/path'), /credentials/);
  assert.throws(() => safeInboxSourceUrl('/relative'), /абсолютным URL/);
});
