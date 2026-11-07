// Узкий data-plane adapter GitHub Issues -> общий Inbox capability.
//
// Provider lifecycle и credentials намеренно остаются снаружи. Внедрённый lease
// может принадлежать как живому runtime, так и сохранённому disconnected account:
// во втором случае coordinator сам помечает результат read-only.

import { isPlainRecord } from '../../../../shared/lib/objects.ts';

import { assertAccountRef } from '../inbox/identity.ts';
import { normalizeGitHubRepositoryId } from './accountBindings.ts';
import {
  githubActivationCodec,
  githubActivationEpochFor,
  githubActivationMarker,
  githubIssueBundleKey,
} from './activation.ts';
import { normalizeOpenedIssue } from './normalize.ts';

const CHANNEL = 'github';
const LABEL = 'GitHub Issues';
const MAX_SCAN_ROWS = 10_000;
const MAX_LIMIT = MAX_SCAN_ROWS;
const SCAN_PAGE_ROWS = 1000;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY_RE = /^[A-Za-z0-9._-]{1,100}$/u;

export class GitHubInboxChannelError extends Error {
  code: string;

  statusCode: number;

  constructor(code: string, message: string, statusCode = 500, cause: unknown = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GitHubInboxChannelError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

type Payload = Record<string, unknown>;

type AnyFunction = (...args: never[]) => unknown;

// Аренда namespace одного account. Она приходит из runtime подключения и
// проверяется целиком: наполовину верная аренда — это чужой репозиторий.
interface LeaseOwner {
  raw: Payload;
  accountRef: string;
  generation: string | number;
  repositoryId: string;
  repositoryNumber: number;
  repositoryFullName: string;
  archive: { head: AnyFunction; list: AnyFunction } & Payload;
  rules: { ruleFor: AnyFunction } & Payload;
  inboxState: Payload;
  isCurrent: AnyFunction;
  release: AnyFunction;
}

interface ActivationBounds {
  afterSeq: number;
  throughSeq: number | null;
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (code: string, message: string, statusCode?: number, cause?: unknown) => never = (
  code,
  message,
  statusCode = 500,
  cause = null,
) => {
  throw new GitHubInboxChannelError(code, message, statusCode, cause);
};

function callable(value: unknown, where: string): AnyFunction {
  if (typeof value !== 'function') {
    fail('github_inbox_invalid_config', `${where} должен быть функцией.`);
  }

  return value as AnyFunction;
}

function trustedFullName(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 240) {
    fail('github_inbox_invalid_context', 'Verified repository fullName имеет неверный формат.');
  }
  const parts = value.split('/');
  if (parts.length !== 2 || !OWNER_RE.test(parts[0] ?? '') || !REPOSITORY_RE.test(parts[1] ?? '')
      || parts[1] === '.' || parts[1] === '..') {
    fail('github_inbox_invalid_context', 'Verified repository fullName имеет неверный формат.');
  }
  return value;
}

function trustedRepositoryNumber(repositoryId: string): number {
  const value = Number(repositoryId);
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== repositoryId) {
    fail(
      'github_inbox_invalid_context',
      'GitHub normalizer v1 требует repositoryId в диапазоне positive safe integer.',
    );
  }
  return value;
}

function generationOf(value: unknown): string | number {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;

  return fail('github_inbox_invalid_context', 'GitHub Inbox lease имеет неверную generation.');
}

function inboxStateOf(source: unknown): Payload {
  if (!source || typeof source !== 'object') {
    fail('github_inbox_invalid_context', 'GitHub Inbox lease не выдал inboxState.');
  }
  const value = source as Payload;
  for (const method of ['read', 'summary', 'activationWindows', 'activate', 'deactivate']) {
    if (typeof value[method] !== 'function') {
      fail('github_inbox_invalid_context', `GitHub inboxState требует ${method}().`);
    }
  }

  return value;
}

function archiveOf(source: unknown): LeaseOwner['archive'] {
  const value = (source ?? {}) as Payload;
  if (!source || typeof source !== 'object'
      || typeof value.head !== 'function' || typeof value.list !== 'function') {
    fail('github_inbox_invalid_context', 'GitHub Inbox lease не выдал archive head/list contract.');
  }

  return value as LeaseOwner['archive'];
}

function rulesOf(source: unknown): LeaseOwner['rules'] {
  const value = (source ?? {}) as Payload;
  if (!source || typeof source !== 'object' || typeof value.ruleFor !== 'function') {
    fail('github_inbox_invalid_context', 'GitHub Inbox lease не выдал rules.ruleFor contract.');
  }

  return value as LeaseOwner['rules'];
}

function leaseOf(raw: unknown): LeaseOwner {
  if (!isPlainRecord(raw) || !isPlainRecord(raw.context)) {
    fail('github_inbox_invalid_context', 'acquireInboxLease вернул неверный lease.');
  }
  const context = raw.context as Payload;
  let accountRef: string;
  try {
    accountRef = assertAccountRef(raw.accountRef, 'GitHub Inbox lease.accountRef') as string;
  } catch (err) {
    fail('github_inbox_invalid_context', 'GitHub Inbox lease имеет неверный accountRef.', 500, err);
  }
  const repositoryId = normalizeGitHubRepositoryId(context.repositoryId);
  return {
    raw,
    accountRef,
    generation: generationOf(raw.generation),
    repositoryId,
    repositoryNumber: trustedRepositoryNumber(repositoryId),
    repositoryFullName: trustedFullName(context.repositoryFullName),
    archive: archiveOf(context.archive),
    rules: rulesOf(context.rules),
    inboxState: inboxStateOf(context.inboxState),
    isCurrent: callable(raw.isCurrent, 'GitHub Inbox lease.isCurrent'),
    release: callable(raw.release, 'GitHub Inbox lease.release'),
  };
}

function positiveLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    fail('github_inbox_invalid_request', `limit должен быть целым 1..${MAX_LIMIT}.`, 400);
  }
  return value;
}

function safeNow(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('github_inbox_invalid_request', 'nowMs должен быть неотрицательным safe integer.', 400);
  }
  return value;
}

function activationBounds(windows: unknown): ActivationBounds | null {
  if (!Array.isArray(windows)) {
    fail('github_inbox_invalid_request', 'activationWindows должен быть массивом.');
  }
  if (windows.length === 0) return null;

  // Helper одновременно проверяет exact shape и непрерывную нумерацию epochs.
  githubActivationEpochFor({ seq: 0, occurredAt: 0 }, windows);
  const entries = windows as { startMarker: unknown; endMarker: unknown }[];
  const starts = entries.map((window) => githubActivationCodec.decode(window.startMarker).afterSeq);
  const ends = entries.map((window) => (
    window.endMarker === null ? null : githubActivationCodec.decode(window.endMarker).afterSeq
  ));
  return {
    afterSeq: Math.min(...starts),
    throughSeq: ends.includes(null) ? null : Math.max(...ends as number[]),
  };
}

function policyOf(rule: unknown, repositoryId: string): Payload {
  if (!isPlainRecord(rule)) {
    fail('github_inbox_invalid_policy', 'GitHub repository rule имеет неверный формат.');
  }
  let owner: string;
  try {
    owner = normalizeGitHubRepositoryId(rule.repositoryId, 'rule.repositoryId');
  } catch (err) {
    fail('github_inbox_invalid_policy', 'GitHub repository rule имеет неверного owner.', 500, err);
  }
  if (owner !== repositoryId) {
    fail('github_inbox_invalid_policy', 'GitHub repository rule принадлежит другому repository.');
  }
  return {
    // Channel + accountRef уже входят в общий scopeRef, поэтому immutable repository.id
    // является полным policy scope внутри этой пары owner-ов.
    scopeId: repositoryId,
    project: rule.project,
    kind: rule.kind,
    b24: structuredClone(rule.b24),
    autoTask: structuredClone(rule.autoTask),
  };
}

function issueUrl(issue: unknown, repositoryFullName: string): string {
  if (!isPlainRecord(issue) || typeof issue.number !== 'number'
      || !Number.isSafeInteger(issue.number) || issue.number < 1) {
    fail('github_inbox_invalid_archive', 'GitHub issue не содержит безопасный issue number.');
  }
  const canonical = `https://github.com/${repositoryFullName}/issues/${issue.number}`;

  // Используем native html_url только после exact-проверки. При rename/transfer
  // старый snapshot может содержать прежний путь — тогда адрес безопасно строится
  // из текущего verified fullName и provider issue number.
  if (issue.html_url !== undefined && issue.html_url !== null) {
    if (typeof issue.html_url !== 'string') {
      fail('github_inbox_invalid_archive', 'GitHub issue.html_url имеет неверный тип.');
    }
    try {
      const native = new URL(issue.html_url as string);
      const nativeSafe = native.protocol === 'https:'
        && native.hostname === 'github.com'
        && native.port === ''
        && native.username === ''
        && native.password === ''
        && native.search === ''
        && native.hash === ''
        && native.href === canonical;
      if (nativeSafe) return canonical;
    } catch {
      // Ниже используется только заново построенный trusted URL.
    }
  }
  return canonical;
}

function normalizedRow(row: unknown, index: number, owner: LeaseOwner) {
  if (!isPlainRecord(row)) {
    fail('github_inbox_invalid_archive', `GitHub archive row ${index} не является объектом.`);
  }
  if (row.channel !== CHANNEL || row.accountRef !== owner.accountRef) {
    fail('github_inbox_invalid_archive', `GitHub archive row ${index} принадлежит другому owner.`);
  }
  let repositoryId: string;
  let issueId: string;
  try {
    repositoryId = normalizeGitHubRepositoryId(row.repositoryId, `archive row ${index}.repositoryId`);
    issueId = normalizeGitHubRepositoryId(row.issueId, `archive row ${index}.issueId`);
  } catch (err) {
    fail('github_inbox_invalid_archive', `GitHub archive row ${index} имеет неверную identity.`, 500, err);
  }
  if (repositoryId !== owner.repositoryId
      || typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 1
      || typeof row.occurredAt !== 'number'
      || !Number.isSafeInteger(row.occurredAt) || row.occurredAt < 0
      || !isPlainRecord(row.snapshot)) {
    fail('github_inbox_invalid_archive', `GitHub archive row ${index} нарушает owner/position contract.`);
  }
  const message = normalizeOpenedIssue({
    action: 'opened',
    repository: {
      id: owner.repositoryNumber,
      full_name: owner.repositoryFullName,
    },
    issue: row.snapshot,
    sender: null,
  }, {
    accountRef: owner.accountRef,
    expectedRepositoryId: owner.repositoryId,
  });
  if (message.id !== issueId || message.occurredAt !== row.occurredAt) {
    fail('github_inbox_invalid_archive', `GitHub archive row ${index} не совпадает со своим snapshot.`);
  }
  return { message, sourceUrl: issueUrl(row.snapshot, owner.repositoryFullName) };
}

async function scanAuthorizedRows({ archive, bounds, windows, limit, assertCurrent }: {
  archive: LeaseOwner['archive'];
  bounds: ActivationBounds;
  windows: unknown;
  limit: number;
  assertCurrent: () => Promise<void>;
}): Promise<{ entries: { row: Payload; activationEpoch: number }[]; truncated: boolean }> {
  const eligible: { row: Payload; activationEpoch: number }[] = [];
  let cursor = bounds.afterSeq;
  let scanned = 0;
  let uncertainMore = false;

  while (eligible.length <= limit && scanned < MAX_SCAN_ROWS) {
    const pageLimit = Math.min(SCAN_PAGE_ROWS, MAX_SCAN_ROWS - scanned);
    await assertCurrent();
    const rows = await (archive.list as (input: unknown) => Promise<unknown>)({
      afterSeq: cursor,
      throughSeq: bounds.throughSeq,
      limit: pageLimit,
    }) as Payload[];
    await assertCurrent();
    if (!Array.isArray(rows) || rows.length > pageLimit) {
      fail('github_inbox_invalid_archive', 'GitHub archive.list вернул неверный page.');
    }
    if (rows.length === 0) break;

    for (const row of rows) {
      if (typeof row?.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq <= cursor) {
        fail('github_inbox_invalid_archive', 'GitHub archive.list нарушил возрастающий seq cursor.');
      }
      cursor = row.seq;
      scanned += 1;
      const activationEpoch = githubActivationEpochFor(row, windows);
      if (activationEpoch !== null) eligible.push({ row, activationEpoch });
      if (eligible.length > limit || scanned >= MAX_SCAN_ROWS) break;
    }

    if (eligible.length > limit || rows.length < pageLimit) break;
    if (bounds.throughSeq !== null && cursor >= bounds.throughSeq) break;
  }

  if (eligible.length <= limit && scanned >= MAX_SCAN_ROWS) {
    await assertCurrent();
    const probe = await (archive.list as (input: unknown) => Promise<unknown>)({
      afterSeq: cursor,
      throughSeq: bounds.throughSeq,
      limit: 1,
    }) as unknown[];
    await assertCurrent();
    if (!Array.isArray(probe) || probe.length > 1) {
      fail('github_inbox_invalid_archive', 'GitHub archive.list вернул неверный truncation probe.');
    }
    uncertainMore = probe.length === 1;
  }

  return {
    entries: eligible.slice(0, limit),
    truncated: eligible.length > limit || uncertainMore,
  };
}

/**
 * Создаёт capability общего Inbox без каких-либо знаний о PAT/webhook lifecycle.
 *
 * acquireInboxLease() должен вернуть immutable lease:
 * {accountRef,generation,isCurrent,release,context:
 *   {repositoryId,repositoryFullName,archive,rules,inboxState}}.
 */
export function createGitHubInboxChannel({ enabled, state, acquireInboxLease, isProjectDeleted }: {
  isProjectDeleted?: (id: string) => boolean;
  enabled?: unknown;
  state?: unknown;
  acquireInboxLease?: unknown;
} = {}) {
  const enabledCallback = callable(enabled, 'enabled');
  const stateCallback = callable(state, 'state');
  const acquireCallback = callable(acquireInboxLease, 'acquireInboxLease');

  const deletedCallback = callable(isProjectDeleted, 'isProjectDeleted') as (id: string) => boolean;

  /**
   * Проверка выполняется повторно после асинхронного чтения политики и архива.
   * Ошибка настроек закрывает автоматическую работу, сохраняя raw правила.
   */
  function deleted(project: unknown): boolean {
    try {
      return Boolean(deletedCallback(String(project || '')));
    } catch {
      return fail('github_inbox_invalid_policy', 'Не удалось проверить регистрацию проекта.');
    }
  }

  return {
    id: CHANNEL,
    label: LABEL,
    grouping: { settleMs: 0, bundleKeyOf: githubIssueBundleKey },

    async enabled() {
      return Boolean(await enabledCallback());
    },

    async state() {
      const raw = await stateCallback();
      if (!isPlainRecord(raw)) {
        fail('github_inbox_invalid_state', 'GitHub channel state callback вернул не объект.');
      }
      // Fixed projection: provider identity, generation, PAT и webhook secret не могут
      // случайно стать частью capability state даже до общего public mapper-а.
      return {
        connection: raw.connection,
        participation: raw.participation,
        reason: raw.reason ?? null,
      };
    },

    async acquireInboxContext() {
      const rawLease = await acquireCallback() as Payload;
      let owner: LeaseOwner;
      try {
        owner = leaseOf(rawLease);
      } catch (err) {
        try {
          await (rawLease?.release as AnyFunction | undefined)?.call(rawLease);
        } catch { /* сохраняем исходную ошибку */ }
        throw err;
      }

      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await owner.release.call(owner.raw);
      };
      const isCurrent = async () => Boolean(await owner.isCurrent.call(owner.raw));
      const assertCurrent = async () => {
        if (!await isCurrent()) {
          fail('stale_generation', 'GitHub account generation изменилась во время Inbox operation.', 409);
        }
      };
      const sourceUrls = new Map<string, string>();

      try {
        await assertCurrent();
      } catch (err) {
        await release().catch(() => {});
        throw err;
      }

      return {
        accountRef: owner.accountRef,
        generation: owner.generation,
        inboxState: owner.inboxState,

        async createActivationMarker({ nowMs }: { nowMs?: unknown } = {}) {
          const at = safeNow(nowMs);

          await assertCurrent();
          const afterSeq = await (owner.archive.head as () => Promise<number>)();

          await assertCurrent();

          return githubActivationMarker({ afterSeq, nowMs: at });
        },

        async listAuthorizedBatches({ nowMs, limit, activationWindows }: {
          nowMs?: unknown;
          limit?: unknown;
          activationWindows?: unknown;
        } = {}) {
          safeNow(nowMs);
          const requested = positiveLimit(limit);
          await assertCurrent();
          const bounds = activationBounds(activationWindows);
          sourceUrls.clear();
          if (bounds === null) {
            await assertCurrent();
            return [];
          }

          // Allowlist раньше archive: пустые rules не позволяют даже прочитать и
          // нормализовать сохранённый issue text в Inbox data plane.
          await assertCurrent();
          const ruleFor = owner.rules.ruleFor as (id: string) => Promise<unknown>;
          const rule = await ruleFor.call(owner.rules, owner.repositoryId);
          await assertCurrent();
          if (rule === null) return [];
          const policy = policyOf(rule, owner.repositoryId);

          if (deleted(policy.project)) {
            return [];
          }

          const scanned = await scanAuthorizedRows({
            archive: owner.archive,
            bounds,
            windows: activationWindows,
            limit: requested,
            assertCurrent,
          });
          if (scanned.truncated && scanned.entries.length === 0) {
            fail('github_inbox_scan_truncated', 'GitHub archive scan исчерпал bound без результата.');
          }

          const batches = scanned.entries.map(({ row, activationEpoch }, index) => {
            const normalized = normalizedRow(row, index, owner);
            const key = JSON.stringify([normalized.message.source.id, normalized.message.id]);
            sourceUrls.set(key, normalized.sourceUrl);
            return {
              activationEpoch,
              source: { ...normalized.message.source },
              messages: [normalized.message],
              policy: structuredClone(policy),
              truncated: scanned.truncated,
            };
          });
          await assertCurrent();

          return deleted(policy.project) ? [] : batches;
        },

        sourceUrl({ source, message }: { source?: Payload; message?: Payload } = {}) {
          const key = JSON.stringify([source?.id, message?.id]);
          const value = sourceUrls.get(key);
          const parent = message?.source as Payload | undefined;
          if (!value || source?.id !== owner.repositoryId || parent?.id !== source.id) {
            fail('github_inbox_invalid_source', 'GitHub source URL запрошен вне authorized batch.');
          }
          return value;
        },

        async materializeAttachments(attachments: unknown) {
          await assertCurrent();
          if (!Array.isArray(attachments) || attachments.length !== 0) {
            fail('github_inbox_invalid_attachments', 'GitHub Issues v1 не поддерживает attachments.');
          }
          await assertCurrent();
          return { files: [], skipped: [] };
        },

        isCurrent,
        release,
      };
    },
  };
}

export default createGitHubInboxChannel;
