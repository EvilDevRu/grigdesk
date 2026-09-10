// Fail-closed allowlist одного GitHub repository → проект/B24 policy.
// Отсутствующий файл и пустой список означают «не разрешено ничего»; автомат у
// нового правила выключен, пока человек не включит его явно.
import { createHash, timingSafeEqual } from 'node:crypto';

import { assertAccountRef } from '../inbox/identity.ts';
import {
  GitHubStoreError,
  atomicWriteJson,
  normalizeGitHubRepositoryId,
  readJsonNoFollow,
} from './accountBindings.ts';

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

export interface GitHubRuleB24 {
  responsibleId: number | null;
  groupId: number | null;
  priority: number;
}

export interface GitHubRuleAutoTask {
  enabled: boolean;
  minConfidence: number;
  maxPerDay: number;
}

// Одно правило allowlist. `agentSearch` дописан к схеме позже: у прежних записей
// его нет, и такая запись обязана читаться как «агентам закрыто».
export interface GitHubRule {
  repositoryId: string;
  project: string;
  kind: string;
  b24: GitHubRuleB24;
  autoTask: GitHubRuleAutoTask;
  agentSearch: boolean;
}

export interface GitHubPolicy {
  rules: GitHubRule[];
  policyFingerprint: string;
}

export interface GitHubRulesStoreOptions {
  file?: string;
  accountRef?: unknown;
  repositoryId?: unknown;
  now?: () => number;
}

type Payload = Record<string, unknown>;

function fail(code: string, message: string, cause: unknown = null): never {
  throw new GitHubStoreError(code, message, cause);
}

function isPlainObject(value: unknown): value is Payload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactObject(value: unknown, keys: string[], where: string): void {
  if (!isPlainObject(value)) fail('github_rules_invalid', `${where}: ожидался объект.`);
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, index) => key !== expected[index])) {
    fail('github_rules_invalid', `${where}: схема полей не совпадает с версией 1.`);
  }
}

function hasExactKeys(value: unknown, keys: string[]): boolean {
  if (!isPlainObject(value)) return false;
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  return own.length === expected.length
    && own.every((key, index) => key === expected[index]);
}

function safeTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail('github_rules_invalid', 'updatedAtMs должен быть положительным Unix milliseconds.');
  }
  return value;
}

function nullablePositiveInt(value: unknown, where: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail('github_rules_invalid', `${where}: ожидался положительный safe integer или null.`);
  }
  return value;
}

function normalizeB24(source: unknown, { stored }: { stored: boolean }): GitHubRuleB24 {
  if (source === undefined && !stored) {
    return { responsibleId: null, groupId: null, priority: 1 };
  }
  exactObject(source, B24_KEYS, 'rule.b24');
  const raw = source as Payload;
  if (![0, 1, 2].includes(raw.priority as number)) {
    fail('github_rules_invalid', 'rule.b24.priority должен быть 0, 1 или 2.');
  }

  return {
    responsibleId: nullablePositiveInt(raw.responsibleId, 'rule.b24.responsibleId'),
    groupId: nullablePositiveInt(raw.groupId, 'rule.b24.groupId'),
    priority: raw.priority as number,
  };
}

function normalizeAutoTask(
  source: unknown,
  { stored }: { stored: boolean },
): GitHubRuleAutoTask {
  if (source === undefined && !stored) {
    return { enabled: false, minConfidence: 0.7, maxPerDay: 10 };
  }
  exactObject(source, AUTO_KEYS, 'rule.autoTask');
  const raw = source as Payload;
  if (typeof raw.enabled !== 'boolean'
      || typeof raw.minConfidence !== 'number' || !Number.isFinite(raw.minConfidence)
      || raw.minConfidence < 0 || raw.minConfidence > 1
      || typeof raw.maxPerDay !== 'number'
      || !Number.isSafeInteger(raw.maxPerDay) || raw.maxPerDay < 0 || raw.maxPerDay > 100) {
    fail('github_rules_invalid', 'rule.autoTask имеет значения вне строгих границ v1.');
  }

  return {
    enabled: raw.enabled,
    minConfidence: raw.minConfidence,
    maxPerDay: raw.maxPerDay,
  };
}

interface ValidateRuleOptions {
  repositoryId: string;
  projects?: string[] | null;
  stored?: boolean;
}

function validateRule(
  source: unknown,
  { repositoryId, projects = null, stored = false }: ValidateRuleOptions,
): GitHubRule {
  if (!isPlainObject(source)) fail('github_rules_invalid', 'GitHub rule должен быть объектом.');
  const raw = source as Payload;
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
  const kind = (raw.kind === undefined && !stored ? 'bug' : raw.kind) as string;
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

function validateDocument(
  source: unknown,
  { accountRef, repositoryId }: { accountRef: string; repositoryId: string },
) {
  exactObject(source, DOCUMENT_KEYS, 'GitHub rules store');
  const raw = source as Payload;
  if (raw.schemaVersion !== 1 || raw.channel !== 'github' || raw.accountRef !== accountRef
      || normalizeGitHubRepositoryId(raw.repositoryId) !== repositoryId) {
    fail('github_rules_owner_mismatch', 'GitHub rules store принадлежит другому account owner.');
  }
  const updatedAtMs = safeTimestamp(raw.updatedAtMs);
  if (!Array.isArray(raw.rules) || raw.rules.length > 1) {
    fail('github_rules_invalid', 'GitHub v1 допускает не больше одного repository rule.');
  }
  return {
    schemaVersion: 1,
    channel: 'github',
    accountRef,
    repositoryId,
    updatedAtMs,
    rules: (raw.rules as unknown[]).map(
      (rule) => validateRule(rule, { repositoryId, stored: true }),
    ),
  };
}

const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;

function fingerprintFor(
  { accountRef, repositoryId, rules }: {
    accountRef: string;
    repositoryId: string;
    rules: GitHubRule[];
  },
): string {
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
export function githubRulesPolicyFingerprint(
  { accountRef, repositoryId, rules }: {
    accountRef?: unknown;
    repositoryId?: unknown;
    rules?: unknown;
  },
): string {
  let owner: string;
  try { owner = assertAccountRef(accountRef) as string; } catch (err) {
    fail('github_rules_owner_mismatch', 'Policy fingerprint получил неверный accountRef.', err);
  }
  const repository = normalizeGitHubRepositoryId(repositoryId);
  if (!Array.isArray(rules) || rules.length > 1) {
    fail('github_rules_invalid', 'Policy fingerprint принимает не больше одного repository rule.');
  }
  const clean = (rules as unknown[]).map((rule) => validateRule(rule, {
    repositoryId: repository,
    stored: true,
  }));
  return fingerprintFor({ accountRef: owner, repositoryId: repository, rules: clean });
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const stalePolicy: (message: string) => never = (message) => {
  const error = new GitHubStoreError('github_rules_stale_policy', message);

  Object.assign(error, { statusCode: 409 });
  throw error;
};

function sameFingerprint(actual: string, expected: string): boolean {
  if (!POLICY_FINGERPRINT_RE.test(expected)) {
    fail('github_rules_invalid', 'expectedPolicyFingerprint имеет неверный формат.');
  }
  return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

export class GitHubRulesStore {
  accountRef!: string;

  repositoryId: string;

  file: string;

  now: () => number;

  queue: Promise<unknown>;

  constructor({ file, accountRef, repositoryId, now = Date.now }: GitHubRulesStoreOptions) {
    if (typeof file !== 'string' || !file) throw new TypeError('GitHubRulesStore: file обязателен.');
    try { this.accountRef = assertAccountRef(accountRef) as string; } catch (err) {
      fail('github_rules_owner_mismatch', 'GitHubRulesStore получил неверный accountRef.', err);
    }
    this.repositoryId = normalizeGitHubRepositoryId(repositoryId);
    this.file = file;
    this.now = now;
    this.queue = Promise.resolve();
  }

  _enqueue<Result>(fn: () => Promise<Result>): Promise<Result> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  async _read(): Promise<GitHubRule[]> {
    const snapshot = await readJsonNoFollow(this.file, { missing: null, maxBytes: MAX_RULES_BYTES });
    if (!snapshot) return [];
    return validateDocument(snapshot.data, {
      accountRef: this.accountRef,
      repositoryId: this.repositoryId,
    }).rules;
  }

  _policy(rules: GitHubRule[]): GitHubPolicy {
    return {
      rules: clone(rules),
      policyFingerprint: githubRulesPolicyFingerprint({
        accountRef: this.accountRef,
        repositoryId: this.repositoryId,
        rules,
      }),
    };
  }

  async _persist(rules: GitHubRule[]): Promise<GitHubRule[]> {
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

  async read(): Promise<GitHubRule[]> {
    return clone(await this._read());
  }

  async readPolicy(): Promise<GitHubPolicy> {
    return this._policy(await this._read());
  }

  async write(
    rules: unknown,
    { projects = null }: { projects?: string[] | null } = {},
  ): Promise<GitHubRule[]> {
    if (!Array.isArray(rules) || rules.length > 1) {
      fail('github_rules_invalid', 'GitHub v1 принимает список из нуля или одного repository rule.');
    }
    const clean = (rules as unknown[]).map((rule) => validateRule(rule, {
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

  async setAgentSearch(
    { enabled, expectedPolicyFingerprint }: {
      enabled?: unknown;
      expectedPolicyFingerprint?: unknown;
    } = {},
  ): Promise<GitHubPolicy> {
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
      const rules = await this._persist([{ ...current[0] as GitHubRule, agentSearch: enabled }]);
      return this._policy(rules);
    });
  }

  async ruleFor(repositoryId: unknown): Promise<GitHubRule | null> {
    const target = normalizeGitHubRepositoryId(repositoryId);
    if (target !== this.repositoryId) return null;
    const [rule] = await this._read();
    return rule ? clone(rule) : null;
  }
}
