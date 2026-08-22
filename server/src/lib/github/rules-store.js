// Fail-closed allowlist одного GitHub repository → проект/B24 policy.
// Отсутствующий файл и пустой список означают «не разрешено ничего»; автомат у
// нового правила выключен, пока человек не включит его явно.
import { createHash, timingSafeEqual } from 'node:crypto';

import { assertAccountRef } from '../inbox/identity.js';
import {
  GitHubStoreError,
  atomicWriteJson,
  normalizeGitHubRepositoryId,
  readJsonNoFollow,
} from './account-bindings.js';

const MAX_RULES_BYTES = 1024 * 1024;
const DOCUMENT_KEYS = [
  'schemaVersion', 'channel', 'accountRef', 'repositoryId', 'updatedAtMs', 'rules',
];
const LEGACY_RULE_KEYS = ['repositoryId', 'project', 'kind', 'b24', 'autoTask'];
const RULE_KEYS = [...LEGACY_RULE_KEYS, 'agentSearch'];
const B24_KEYS = ['responsibleId', 'groupId', 'priority'];
const AUTO_KEYS = ['enabled', 'minConfidence', 'maxPerDay'];
const KINDS = new Set(['bug', 'wish']);
const POLICY_FINGERPRINT_RE = /^ghpol1:[0-9a-f]{64}$/u;

function fail(code, message, cause = null) {
  throw new GitHubStoreError(code, message, cause);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactObject(value, keys, where) {
  if (!isPlainObject(value)) fail('github_rules_invalid', `${where}: ожидался объект.`);
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, index) => key !== expected[index])) {
    fail('github_rules_invalid', `${where}: схема полей не совпадает с версией 1.`);
  }
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  return own.length === expected.length
    && own.every((key, index) => key === expected[index]);
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('github_rules_invalid', 'updatedAtMs должен быть положительным Unix milliseconds.');
  }
  return value;
}

function nullablePositiveInt(value, where) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('github_rules_invalid', `${where}: ожидался положительный safe integer или null.`);
  }
  return value;
}

function normalizeB24(raw, { stored }) {
  if (raw === undefined && !stored) {
    return { responsibleId: null, groupId: null, priority: 1 };
  }
  exactObject(raw, B24_KEYS, 'rule.b24');
  if (![0, 1, 2].includes(raw.priority)) {
    fail('github_rules_invalid', 'rule.b24.priority должен быть 0, 1 или 2.');
  }
  return {
    responsibleId: nullablePositiveInt(raw.responsibleId, 'rule.b24.responsibleId'),
    groupId: nullablePositiveInt(raw.groupId, 'rule.b24.groupId'),
    priority: raw.priority,
  };
}

function normalizeAutoTask(raw, { stored }) {
  if (raw === undefined && !stored) {
    return { enabled: false, minConfidence: 0.7, maxPerDay: 10 };
  }
  exactObject(raw, AUTO_KEYS, 'rule.autoTask');
  if (typeof raw.enabled !== 'boolean'
      || typeof raw.minConfidence !== 'number' || !Number.isFinite(raw.minConfidence)
      || raw.minConfidence < 0 || raw.minConfidence > 1
      || !Number.isSafeInteger(raw.maxPerDay) || raw.maxPerDay < 0 || raw.maxPerDay > 100) {
    fail('github_rules_invalid', 'rule.autoTask имеет значения вне строгих границ v1.');
  }
  return {
    enabled: raw.enabled,
    minConfidence: raw.minConfidence,
    maxPerDay: raw.maxPerDay,
  };
}

function validateRule(raw, { repositoryId, projects = null, stored = false } = {}) {
  if (!isPlainObject(raw)) fail('github_rules_invalid', 'GitHub rule должен быть объектом.');
  if (stored) {
    if (!hasExactKeys(raw, RULE_KEYS) && !hasExactKeys(raw, LEGACY_RULE_KEYS)) {
      fail('github_rules_invalid', 'GitHub rule: схема полей не совпадает с версией 1.');
    }
  } else {
    const allowed = new Set(LEGACY_RULE_KEYS);
    if (Object.keys(raw).some((key) => !allowed.has(key))) {
      fail(
        'github_rules_invalid',
        'GitHub rule содержит неизвестные поля; agentSearch меняется только отдельным CAS.',
      );
    }
  }

  const owner = normalizeGitHubRepositoryId(raw.repositoryId, 'rule.repositoryId');
  if (owner !== repositoryId) fail('github_rules_owner_mismatch', 'GitHub rule принадлежит другому repository.');
  if (typeof raw.project !== 'string' || !raw.project.trim()
      || Buffer.byteLength(raw.project.trim(), 'utf8') > 256) {
    fail('github_rules_invalid', 'rule.project обязателен и должен быть короче 256 байт.');
  }
  const project = raw.project.trim();
  if (Array.isArray(projects) && projects.length && !projects.includes(project)) {
    fail('github_rules_invalid', `Проект «${project}» не найден.`);
  }
  const kind = raw.kind === undefined && !stored ? 'bug' : raw.kind;
  if (!KINDS.has(kind)) fail('github_rules_invalid', 'rule.kind должен быть bug или wish.');
  if (stored && raw.agentSearch !== undefined && typeof raw.agentSearch !== 'boolean') {
    fail('github_rules_invalid', 'rule.agentSearch должен быть boolean.');
  }
  return {
    repositoryId: owner,
    project,
    kind,
    b24: normalizeB24(raw.b24, { stored }),
    autoTask: normalizeAutoTask(raw.autoTask, { stored }),
    // Поле additive: существующий schemaVersion=1 без него всегда закрыт агентам.
    agentSearch: stored ? raw.agentSearch === true : false,
  };
}

function validateDocument(raw, { accountRef, repositoryId }) {
  exactObject(raw, DOCUMENT_KEYS, 'GitHub rules store');
  if (raw.schemaVersion !== 1 || raw.channel !== 'github' || raw.accountRef !== accountRef
      || normalizeGitHubRepositoryId(raw.repositoryId) !== repositoryId) {
    fail('github_rules_owner_mismatch', 'GitHub rules store принадлежит другому account owner.');
  }
  safeTimestamp(raw.updatedAtMs);
  if (!Array.isArray(raw.rules) || raw.rules.length > 1) {
    fail('github_rules_invalid', 'GitHub v1 допускает не больше одного repository rule.');
  }
  return {
    schemaVersion: 1,
    channel: 'github',
    accountRef,
    repositoryId,
    updatedAtMs: raw.updatedAtMs,
    rules: raw.rules.map((rule) => validateRule(rule, { repositoryId, stored: true })),
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function fingerprintFor({ accountRef, repositoryId, rules }) {
  return `ghpol1:${createHash('sha256').update(JSON.stringify({
    fingerprintVersion: 1,
    channel: 'github',
    accountRef,
    repositoryId,
    rules,
  }), 'utf8').digest('hex')}`;
}

/**
 * Pure canonical fingerprint current GitHub policy. Он включает agentSearch,
 * human allowlist и exact account/repository owner, но не mutable timestamp.
 */
export function githubRulesPolicyFingerprint({ accountRef, repositoryId, rules }) {
  let owner;
  try { owner = assertAccountRef(accountRef); } catch (err) {
    fail('github_rules_owner_mismatch', 'Policy fingerprint получил неверный accountRef.', err);
  }
  const repository = normalizeGitHubRepositoryId(repositoryId);
  if (!Array.isArray(rules) || rules.length > 1) {
    fail('github_rules_invalid', 'Policy fingerprint принимает не больше одного repository rule.');
  }
  const clean = rules.map((rule) => validateRule(rule, {
    repositoryId: repository,
    stored: true,
  }));
  return fingerprintFor({ accountRef: owner, repositoryId: repository, rules: clean });
}

function stalePolicy(message) {
  const error = new GitHubStoreError('github_rules_stale_policy', message);
  error.statusCode = 409;
  throw error;
}

function sameFingerprint(actual, expected) {
  if (!POLICY_FINGERPRINT_RE.test(expected)) {
    fail('github_rules_invalid', 'expectedPolicyFingerprint имеет неверный формат.');
  }
  return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

export class GitHubRulesStore {
  constructor({ file, accountRef, repositoryId, now = Date.now }) {
    if (typeof file !== 'string' || !file) throw new TypeError('GitHubRulesStore: file обязателен.');
    try { this.accountRef = assertAccountRef(accountRef); } catch (err) {
      fail('github_rules_owner_mismatch', 'GitHubRulesStore получил неверный accountRef.', err);
    }
    this.repositoryId = normalizeGitHubRepositoryId(repositoryId);
    this.file = file;
    this.now = now;
    this.queue = Promise.resolve();
  }

  _enqueue(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  async _read() {
    const snapshot = await readJsonNoFollow(this.file, { missing: null, maxBytes: MAX_RULES_BYTES });
    if (!snapshot) return [];
    return validateDocument(snapshot.data, {
      accountRef: this.accountRef,
      repositoryId: this.repositoryId,
    }).rules;
  }

  _policy(rules) {
    return {
      rules: clone(rules),
      policyFingerprint: githubRulesPolicyFingerprint({
        accountRef: this.accountRef,
        repositoryId: this.repositoryId,
        rules,
      }),
    };
  }

  async _persist(rules) {
    const nowMs = this.now();
    safeTimestamp(nowMs);
    const document = validateDocument({
      schemaVersion: 1,
      channel: 'github',
      accountRef: this.accountRef,
      repositoryId: this.repositoryId,
      updatedAtMs: nowMs,
      rules,
    }, { accountRef: this.accountRef, repositoryId: this.repositoryId });
    await atomicWriteJson(this.file, document, { mode: 0o600 });
    return document.rules;
  }

  async read() {
    return clone(await this._read());
  }

  async readPolicy() {
    return this._policy(await this._read());
  }

  async write(rules, { projects = null } = {}) {
    if (!Array.isArray(rules) || rules.length > 1) {
      fail('github_rules_invalid', 'GitHub v1 принимает список из нуля или одного repository rule.');
    }
    const clean = rules.map((rule) => validateRule(rule, {
      repositoryId: this.repositoryId,
      projects,
      stored: false,
    }));
    return this._enqueue(async () => {
      // Human allowlist editor не владеет agent opt-in. При обычной правке
      // существующее значение сохраняется, новое правило всегда начинается с false.
      const current = await this._read();
      const next = clean.map((rule) => ({
        ...rule,
        agentSearch: current[0]?.repositoryId === rule.repositoryId
          && current[0]?.project === rule.project
          && current[0]?.agentSearch === true,
      }));
      return clone(await this._persist(next));
    });
  }

  async setAgentSearch({ enabled, expectedPolicyFingerprint } = {}) {
    if (typeof enabled !== 'boolean') {
      fail('github_rules_invalid', 'agentSearch.enabled должен быть boolean.');
    }
    if (typeof expectedPolicyFingerprint !== 'string'
        || !POLICY_FINGERPRINT_RE.test(expectedPolicyFingerprint)) {
      fail('github_rules_invalid', 'expectedPolicyFingerprint имеет неверный формат.');
    }
    return this._enqueue(async () => {
      const current = await this._read();
      if (current.length !== 1) {
        stalePolicy('Нельзя изменить agentSearch без текущего human allowlist rule.');
      }
      const before = this._policy(current);
      if (!sameFingerprint(before.policyFingerprint, expectedPolicyFingerprint)) {
        stalePolicy('GitHub policy изменилась после чтения формы.');
      }
      const rules = await this._persist([{ ...current[0], agentSearch: enabled }]);
      return this._policy(rules);
    });
  }

  async ruleFor(repositoryId) {
    const target = normalizeGitHubRepositoryId(repositoryId);
    if (target !== this.repositoryId) return null;
    const [rule] = await this._read();
    return rule ? clone(rule) : null;
  }
}
