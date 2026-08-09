// Криптографическая и identity-граница GitHub webhook. Все проверки чистые,
// HTTP-сервер и сеть здесь не участвуют.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import {
  GitHubWebhookError,
  parseOpenedIssueWebhook,
  parseVerifiedGitHubWebhook,
  validateGitHubWebhookHeaders,
  validateOpenedIssuePayload,
  verifyGitHubWebhookSignature,
} from '../../server/src/lib/github/webhook.js';

const SECRET = 'server-generated-webhook-secret';
const HOOK_ID = '998877';
const REPOSITORY_ID = '123456';
const DELIVERY_ID = '01234567-89ab-4def-8abc-0123456789ab';

function signature(raw, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

function payload(overrides = {}) {
  const base = {
    action: 'opened',
    repository: { id: Number(REPOSITORY_ID), full_name: 'org/repo' },
    issue: {
      id: 7654321,
      title: 'Не открывается форма',
      body: 'Шаги воспроизведения',
      created_at: '2026-08-09T12:34:56Z',
      user: { id: 42, login: 'reporter' },
    },
    sender: { id: 900, login: 'hook-admin' },
  };
  return {
    ...base,
    ...overrides,
    repository: overrides.repository ?? base.repository,
    issue: overrides.issue ?? base.issue,
  };
}

function headers(raw, overrides = {}) {
  return {
    'x-hub-signature-256': signature(raw),
    'x-github-event': 'issues',
    'x-github-delivery': DELIVERY_ID,
    'x-github-hook-id': HOOK_ID,
    'x-github-hook-installation-target-type': 'repository',
    'x-github-hook-installation-target-id': REPOSITORY_ID,
    ...overrides,
  };
}

test('HMAC вычисляется по точным raw bytes, а не по повторно сериализованному JSON', () => {
  const raw = Buffer.from('{\n  "action": "opened"\n}\n');
  const exact = signature(raw);
  const compact = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))));

  assert.equal(verifyGitHubWebhookSignature(raw, exact, SECRET), true);
  assert.equal(verifyGitHubWebhookSignature(compact, exact, SECRET), false);
  assert.equal(verifyGitHubWebhookSignature(raw, `sha256=${'0'.repeat(64)}`, SECRET), false);
  assert.equal(verifyGitHubWebhookSignature(raw, 'sha1=bad', SECRET), false);
});

test('parseVerifiedGitHubWebhook проверяет подпись до JSON parsing', () => {
  const invalidJson = Buffer.from('{not-json');
  const wrongHeaders = { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` };

  assert.throws(
    () => parseVerifiedGitHubWebhook(invalidJson, { headers: wrongHeaders, secret: SECRET }),
    (error) => error instanceof GitHubWebhookError && error.code === 'github_signature_invalid',
  );

  assert.throws(
    () => parseVerifiedGitHubWebhook(invalidJson, {
      headers: { 'x-hub-signature-256': signature(invalidJson) },
      secret: SECRET,
    }),
    (error) => error.code === 'github_json_invalid',
  );
});

test('полная проверка issues/opened связывает delivery, hook и repository', () => {
  const body = payload();
  const raw = Buffer.from(JSON.stringify(body));
  const parsed = parseOpenedIssueWebhook(raw, {
    headers: headers(raw),
    secret: SECRET,
    expectedHookId: HOOK_ID,
    expectedRepositoryId: REPOSITORY_ID,
  });

  assert.equal(parsed.event, 'issues');
  assert.equal(parsed.action, 'opened');
  assert.equal(parsed.deliveryId, DELIVERY_ID);
  assert.equal(parsed.hookId, HOOK_ID);
  assert.equal(parsed.repositoryId, REPOSITORY_ID);
  assert.equal(parsed.issueId, '7654321');
  assert.deepEqual(parsed.payload, body);
  assert.equal(parsed.rawSha256, createHash('sha256').update(raw).digest('hex'));
});

test('headers читаются case-insensitive и требуют один canonical delivery GUID', () => {
  const raw = Buffer.from(JSON.stringify(payload()));
  const mixedCase = new Headers({
    'X-Hub-Signature-256': signature(raw),
    'X-GitHub-Event': 'issues',
    'X-GitHub-Delivery': DELIVERY_ID.toUpperCase(),
    'X-GitHub-Hook-ID': HOOK_ID,
    'X-GitHub-Hook-Installation-Target-Type': 'repository',
    'X-GitHub-Hook-Installation-Target-ID': REPOSITORY_ID,
  });
  const result = validateGitHubWebhookHeaders(mixedCase, {
    expectedHookId: HOOK_ID,
    expectedRepositoryId: REPOSITORY_ID,
  });
  assert.equal(result.deliveryId, DELIVERY_ID);

  assert.throws(
    () => validateGitHubWebhookHeaders({
      ...headers(raw),
      'x-github-delivery': 'not-a-guid',
    }, { expectedHookId: HOOK_ID, expectedRepositoryId: REPOSITORY_ID }),
    (error) => error.code === 'github_delivery_invalid',
  );
});

test('event, hook и installation target проверяются точным сравнением', async (t) => {
  const raw = Buffer.from(JSON.stringify(payload()));
  const cases = [
    ['другое событие', { 'x-github-event': 'issue_comment' }, 'github_event_mismatch'],
    ['другой hook', { 'x-github-hook-id': '998878' }, 'github_hook_mismatch'],
    ['organization target', {
      'x-github-hook-installation-target-type': 'organization',
    }, 'github_target_mismatch'],
    ['другой repository target', {
      'x-github-hook-installation-target-id': '123457',
    }, 'github_repository_mismatch'],
  ];

  for (const [name, changed, code] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => validateGitHubWebhookHeaders(headers(raw, changed), {
          expectedHookId: HOOK_ID,
          expectedRepositoryId: REPOSITORY_ID,
        }),
        (error) => error.code === code,
      );
    });
  }
});

test('payload принимает только opened Issue точного repository и отвергает PR', async (t) => {
  assert.deepEqual(validateOpenedIssuePayload(payload(), {
    expectedRepositoryId: REPOSITORY_ID,
  }), {
    action: 'opened',
    repositoryId: REPOSITORY_ID,
    issueId: '7654321',
  });

  const cases = [
    ['не opened', payload({ action: 'edited' }), 'github_action_ignored'],
    ['другой repository', payload({
      repository: { id: 123457, full_name: 'org/other' },
    }), 'github_repository_mismatch'],
    ['pull request', payload({
      issue: { ...payload().issue, pull_request: { url: 'https://api.github.test/pulls/1' } },
    }), 'github_pull_request_ignored'],
  ];

  for (const [name, candidate, code] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => validateOpenedIssuePayload(candidate, { expectedRepositoryId: REPOSITORY_ID }),
        (error) => error.code === code,
      );
    });
  }
});

test('webhook body ограничен, а строка вместо raw bytes запрещена', () => {
  const raw = Buffer.from(JSON.stringify(payload()));
  assert.throws(
    () => parseVerifiedGitHubWebhook(raw, {
      headers: headers(raw),
      secret: SECRET,
      maxBodyBytes: raw.length - 1,
    }),
    (error) => error.code === 'github_body_too_large',
  );
  assert.throws(
    () => verifyGitHubWebhookSignature(raw.toString('utf8'), signature(raw), SECRET),
    (error) => error.code === 'github_raw_body_required',
  );
});
