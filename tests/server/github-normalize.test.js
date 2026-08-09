// Fixture GitHub Issues доказывает общий InboxMessage контракт без Telegram-полей.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GitHubNormalizeError,
  normalizeOpenedIssue,
} from '../../server/src/lib/github/normalize.js';

const ACCOUNT_REF = 'acc_github_7f3a';
const REPOSITORY_ID = '123456';

function fixture(overrides = {}) {
  const base = {
    action: 'opened',
    repository: {
      id: Number(REPOSITORY_ID),
      full_name: 'acme/support',
      html_url: 'https://github.com/acme/support',
    },
    issue: {
      id: 7654321,
      number: 91,
      title: 'Не открывается форма',
      body: 'Шаг 1\nШаг 2',
      created_at: '2026-08-09T12:34:56Z',
      updated_at: '2026-08-09T14:00:00Z',
      html_url: 'https://github.com/acme/support/issues/91',
      user: { id: 42, login: 'reporter' },
    },
    sender: { id: 900, login: 'repository-admin' },
  };
  return {
    ...base,
    ...overrides,
    repository: overrides.repository ?? base.repository,
    issue: overrides.issue ?? base.issue,
  };
}

const normalize = (payload) => normalizeOpenedIssue(payload, {
  accountRef: ACCOUNT_REF,
  expectedRepositoryId: REPOSITORY_ID,
});

test('issues/opened нормализуется в полный InboxMessage v1', () => {
  assert.deepEqual(normalize(fixture()), {
    schema: 1,
    channel: 'github',
    accountRef: ACCOUNT_REF,
    source: {
      id: REPOSITORY_ID,
      title: 'acme/support',
      threadId: '7654321',
    },
    id: '7654321',
    parentId: null,
    groupId: null,
    occurredAt: Date.UTC(2026, 7, 9, 12, 34, 56) / 1000,
    editedAt: null,
    author: {
      id: '42',
      name: 'reporter',
    },
    text: 'Не открывается форма\n\nШаг 1\nШаг 2',
    attachments: [],
    service: false,
  });
});

test('автор берётся из issue.user, а время — из created_at provider', () => {
  const message = normalize(fixture({
    sender: { id: 42, login: 'не-автор' },
    issue: {
      ...fixture().issue,
      user: { id: 77, login: 'реальный-автор' },
      created_at: '2026-08-08T01:02:03Z',
      updated_at: '2030-01-01T00:00:00Z',
    },
  }));

  assert.deepEqual(message.author, { id: '77', name: 'реальный-автор' });
  assert.equal(message.occurredAt, Date.UTC(2026, 7, 8, 1, 2, 3) / 1000);
  assert.equal(message.editedAt, null);
});

test('null body и удалённый user дают явные пустые значения', () => {
  const message = normalize(fixture({
    issue: {
      ...fixture().issue,
      body: null,
      user: null,
    },
  }));
  assert.equal(message.text, 'Не открывается форма');
  assert.deepEqual(message.author, { id: null, name: '' });
  assert.deepEqual(message.attachments, []);
});

test('локальный issue number и URL не становятся identity', () => {
  const message = normalize(fixture({
    issue: {
      ...fixture().issue,
      number: 7654321,
      html_url: 'https://example.invalid/подмена',
    },
  }));
  assert.equal(message.id, String(fixture().issue.id));
  assert.equal(message.source.threadId, String(fixture().issue.id));
  assert.ok(!Object.hasOwn(message, 'url'));
});

test('normalizer fail-closed отвергает другие action, repository и pull request', async (t) => {
  const cases = [
    ['edited', fixture({ action: 'edited' }), 'github_action_ignored'],
    ['другой repository', fixture({
      repository: { id: 999999, full_name: 'acme/other' },
    }), 'github_repository_mismatch'],
    ['pull request', fixture({
      issue: { ...fixture().issue, pull_request: {} },
    }), 'github_pull_request_ignored'],
  ];

  for (const [name, payload, code] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => normalize(payload),
        (error) => error instanceof GitHubNormalizeError && error.code === code,
      );
    });
  }
});

test('provider timestamp проверяется строго и не нормализует невозможную дату', async (t) => {
  for (const createdAt of [
    '2026-02-30T12:00:00Z',
    '2026-08-09T12:34:56+00:00',
    '2026-08-09T12:34:56.123Z',
    'не-дата',
  ]) {
    await t.test(createdAt, () => {
      assert.throws(
        () => normalize(fixture({
          issue: { ...fixture().issue, created_at: createdAt },
        })),
        (error) => error.code === 'github_created_at_invalid',
      );
    });
  }
});

test('неполные provider identifiers и content не принимаются догадкой', async (t) => {
  const cases = [
    ['issue.id', fixture({ issue: { ...fixture().issue, id: '7654321' } })],
    ['repository.id', fixture({ repository: { ...fixture().repository, id: null } })],
    ['title', fixture({ issue: { ...fixture().issue, title: '' } })],
    ['body', fixture({ issue: { ...fixture().issue, body: { text: 'нет' } } })],
    ['user', fixture({ issue: { ...fixture().issue, user: 'reporter' } })],
  ];

  for (const [name, payload] of cases) {
    await t.test(name, () => {
      assert.throws(() => normalize(payload), (error) => error.code === 'github_payload_invalid');
    });
  }
});
