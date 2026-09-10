import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GitHubContractError,
  parseGitHubAgentSearch,
  parseGitHubPolicy,
  parseGitHubRulesSaved,
  parseGitHubStatus,
} from '../../shared/githubContracts.ts';
import { api } from '../../web/src/shared/apiClient.ts';
import { githubApi, githubPluginDisabled } from '../../web/src/shared/githubApi.ts';

const FINGERPRINT = `ghpol1:${'a'.repeat(64)}`;
const STATUS = {
  configured: true,
  state: 'connected',
  repositoryId: '123456',
  fullName: 'example-org/example-repo',
  connectedAt: 1_786_172_300_000,
  connection: 'connected',
  reason: null,
  cleanupPending: false,
};
const RULE = {
  repositoryId: '123456',
  project: 'cockpit',
  kind: 'bug',
  b24: { responsibleId: null, groupId: 7, priority: 2 },
  autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
  agentSearch: true,
};

test('статус не выносит наружу токен, секрет и внутренний accountRef', () => {
  const parsed = parseGitHubStatus({
    ...STATUS,
    token: 'github_pat_secret',
    secret: 'webhook_secret',
    ingressRef: 'ingress',
    accountRef: 'acc_internal',
    hookId: '999999',
  });

  assert.deepEqual(parsed, STATUS);
  assert.equal(JSON.stringify(parsed).includes('secret'), false);
});

test('состояния привязки и канала закрыты перечислениями', () => {
  assert.throws(() => parseGitHubStatus({ ...STATUS, state: 'наверное' }), /githubStatus\.state/);
  assert.throws(
    () => parseGitHubStatus({ ...STATUS, connection: 'ok' }),
    /githubStatus\.connection/,
  );
  assert.equal(parseGitHubStatus({ ...STATUS, state: null }).state, null);
});

test('правило allowlist переживает отсутствие необязательных блоков', () => {
  const policy = parseGitHubPolicy({
    rules: [{ repositoryId: '123456', project: 'cockpit', kind: 'wish' }],
  });

  assert.deepEqual(policy, {
    rules: [{
      repositoryId: '123456',
      project: 'cockpit',
      kind: 'wish',
      b24: null,
      autoTask: null,
      agentSearch: null,
    }],
    policyFingerprint: null,
  });
  assert.deepEqual(parseGitHubPolicy({ rules: [RULE], policyFingerprint: FINGERPRINT }), {
    rules: [RULE],
    policyFingerprint: FINGERPRINT,
  });
});

test('отпечаток политики чужой формы отвергается, а не становится CAS-значением', () => {
  assert.throws(
    () => parseGitHubPolicy({ rules: [], policyFingerprint: 'ghpol1:короткий' }),
    /githubPolicy\.policyFingerprint/,
  );
  assert.throws(
    () => parseGitHubPolicy({ rules: [], policyFingerprint: 'a'.repeat(64) }),
    /githubPolicy\.policyFingerprint/,
  );
});

test('ступень приоритета и род обращения ограничены объявленным набором', () => {
  const withPriority = (priority) => ({
    rules: [{ ...RULE, b24: { ...RULE.b24, priority } }],
    policyFingerprint: FINGERPRINT,
  });

  assert.equal(parseGitHubPolicy(withPriority(0)).rules[0].b24.priority, 0);
  assert.throws(() => parseGitHubPolicy(withPriority(7)), /b24\.priority/);
  assert.throws(
    () => parseGitHubPolicy({ rules: [{ ...RULE, kind: 'question' }] }),
    /githubPolicy\.rules\[0\]\.kind/,
  );
});

test('сохранение правил и смена доступа подтверждают форму ответа', () => {
  assert.deepEqual(parseGitHubRulesSaved({ ok: true, rules: [RULE] }), [RULE]);
  assert.deepEqual(
    parseGitHubAgentSearch({ ok: true, rules: [RULE], policyFingerprint: FINGERPRINT }),
    { rules: [RULE], policyFingerprint: FINGERPRINT },
  );
  assert.throws(
    () => parseGitHubRulesSaved({ rules: [RULE] }),
    GitHubContractError,
  );
});

test('выключенный плагин отличается от поломки по коду под 404', () => {
  assert.equal(githubPluginDisabled({ status: 404, data: { error: 'plugin_disabled' } }), true);
  assert.equal(githubPluginDisabled({ status: 404, data: { error: 'not_found' } }), false);
  assert.equal(githubPluginDisabled(new Error('Failed to fetch')), false);
});

test('управляющие ручки шлют пустое тело, а ответ на них раздел не читает', async (t) => {
  const seen = [];

  t.mock.method(api, 'post', async (url, body) => {
    seen.push([url, body]);

    return { ok: true };
  });

  await githubApi.recheck();
  await githubApi.disconnect();
  await githubApi.connect('example-org', 'example-repo', 'github_pat_private');

  assert.deepEqual(seen, [
    ['/api/github/recheck', {}],
    ['/api/github/disconnect', {}],
    [
      '/api/github/connect',
      { owner: 'example-org', repo: 'example-repo', token: 'github_pat_private' },
    ],
  ]);
});

test('повреждённый ответ сети не становится состоянием подключения', async (t) => {
  t.mock.method(api, 'get', async () => ({ ...STATUS, connectedAt: 'вчера' }));
  t.mock.method(api, 'put', async () => ({ ok: true, rules: [{ ...RULE, project: 7 }] }));

  await assert.rejects(githubApi.status(), GitHubContractError);
  await assert.rejects(githubApi.saveRules('123456', []), GitHubContractError);
});
