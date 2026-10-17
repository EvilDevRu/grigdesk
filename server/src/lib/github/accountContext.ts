// Сборка per-account stores GitHub. Единственный trusted root приходит из config,
// а accountRef уже проверен как безопасный сегмент: provider id и display name
// никогда не участвуют в пути.
import path from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';

import { errorCode } from '../../../../shared/lib/errors.ts';
import { isPlainRecord } from '../../../../shared/lib/objects.ts';

import { InboxRefCodec, assertAccountRef } from '../inbox/identity.ts';
import { InboxStateStore } from '../inbox/stateStore.ts';
import {
  GitHubStoreError,
  atomicWriteJson,
  normalizeGitHubRepositoryId,
  readJsonNoFollow,
} from './accountBindings.ts';
import { githubActivationCodec } from './activation.ts';
import { GitHubArchiveStore } from './archiveStore.ts';
import { GitHubIngressStateStore } from './ingressStateStore.ts';
import { GitHubRulesStore } from './rulesStore.ts';
import type { GitHubArchiveStore as ArchiveStoreType } from './archiveStore.ts';
import type { GitHubIngressStateStore as IngressStoreType } from './ingressStateStore.ts';
import type { GitHubRulesStore as RulesStoreType } from './rulesStore.ts';

// Namespace одного проверенного репозитория: архив принятых issues, allowlist,
// состояние очереди Inbox и курсор сверки. Всё остальное живёт вне account.
export interface GitHubAccountContext {
  repositoryId: string;
  repositoryFullName: string;
  archive: ArchiveStoreType;
  rules: RulesStoreType;
  inboxState: InstanceType<typeof InboxStateStore>;
  ingressState: IngressStoreType;
}

export interface GitHubAccountRequest {
  accountRef?: unknown;
  repositoryId?: unknown;
  repositoryFullName?: string;
}

export type GitHubAccountContextFactory = (
  request?: GitHubAccountRequest,
) => Promise<GitHubAccountContext>;

type Payload = Record<string, unknown>;

const METADATA_KEYS = [
  'schemaVersion', 'channel', 'accountRef', 'repositoryId', 'repositoryFullName', 'updatedAtMs',
];
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY_RE = /^(?!\.)(?!.*\.\.)(?!.*\.git$)[A-Za-z0-9_.-]{1,100}$/u;

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (code: string, message: string, cause?: unknown) => never = (
  code,
  message,
  cause = null,
) => {
  throw new GitHubStoreError(code, message, cause);
};

async function directory(
  pathname: string,
  { create = false, label = '' }: { create?: boolean; label?: string } = {},
) {
  if (create) {
    try { await mkdir(pathname, { mode: 0o700 }); } catch (err) {
      if (errorCode(err) !== 'EEXIST') {
        fail('github_store_write_failed', `${label} не удалось создать безопасно.`, err);
      }
    }
  }
  let info;
  try { info = await lstat(pathname); } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      fail('github_metadata_missing', `${label} отсутствует.`);
    }
    fail('github_store_unsafe', `${label} нельзя безопасно проверить.`, err);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail('github_store_unsafe', `${label} не является обычным каталогом.`);
  }
  return info;
}

async function accountNamespace(
  root: string,
  accountRef: string,
  { create = false }: { create?: boolean } = {},
): Promise<string> {
  if (create) {
    try { await mkdir(root, { recursive: true, mode: 0o700 }); } catch (err) {
      if (errorCode(err) !== 'EEXIST') {
        fail('github_store_write_failed', 'GitHub trusted root не удалось создать.', err);
      }
    }
  }
  await directory(root, { label: 'GitHub trusted root' });
  const accountsDir = path.join(root, 'accounts');
  await directory(accountsDir, { create, label: 'GitHub accounts directory' });
  const accountDir = path.join(accountsDir, accountRef);
  await directory(accountDir, { create, label: 'GitHub account directory' });
  return accountDir;
}

function exact(value: unknown, keys: string[], where: string): void {
  if (!isPlainRecord(value)) fail('github_metadata_invalid', `${where}: ожидался объект.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('github_metadata_invalid', `${where}: поля не совпадают со schema v1.`);
  }
}

export function normalizeGitHubRepositoryFullName(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 240) {
    fail('github_metadata_invalid', 'GitHub repository full_name имеет неверный формат.');
  }
  const parts = value.split('/');
  if (parts.length !== 2 || !OWNER_RE.test(parts[0] ?? '') || !REPOSITORY_RE.test(parts[1] ?? '')) {
    fail('github_metadata_invalid', 'GitHub repository full_name имеет неверный формат.');
  }
  return `${parts[0]}/${parts[1]}`;
}

function metadata(
  raw: unknown,
  { accountRef, repositoryId }: { accountRef: string; repositoryId: string },
): Payload & { repositoryFullName: string } {
  exact(raw, METADATA_KEYS, 'GitHub account metadata');
  const value = raw as Payload;
  if (value.schemaVersion !== 1 || value.channel !== 'github'
      || value.accountRef !== accountRef
      || normalizeGitHubRepositoryId(value.repositoryId) !== repositoryId
      || typeof value.updatedAtMs !== 'number'
      || !Number.isSafeInteger(value.updatedAtMs) || value.updatedAtMs <= 0) {
    fail('github_metadata_owner_mismatch', 'GitHub account metadata принадлежит другому owner.');
  }

  return {
    ...value,
    repositoryFullName: normalizeGitHubRepositoryFullName(value.repositoryFullName),
  };
}

/**
 * Возвращает async factory, пригодный для GitHubConnection.accountContextFor.
 * Проверенный full_name запоминается рядом с нативными stores: после disconnect
 * credentials можно удалить, а уже принятые Inbox items останутся читаемыми.
 */
export function createGitHubAccountContextFactory(
  { dir, now = Date.now }: { dir?: string; now?: () => number } = {},
): GitHubAccountContextFactory {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new TypeError('GitHub account context: dir должен быть абсолютным trusted path.');
  }
  if (typeof now !== 'function') throw new TypeError('GitHub account context: now должен быть функцией.');
  const root = path.resolve(dir);

  return async function accountContextFor({
    accountRef,
    repositoryId,
    repositoryFullName = '',
  }: GitHubAccountRequest = {}): Promise<GitHubAccountContext> {
    const trustedAccountRef = assertAccountRef(accountRef) as string;
    const trustedRepositoryId = normalizeGitHubRepositoryId(repositoryId);
    if (typeof repositoryFullName !== 'string') {
      fail('github_metadata_invalid', 'GitHub repository full_name должен быть строкой.');
    }
    const online = repositoryFullName.length > 0;
    let trustedFullName = '';
    let updatedAtMs: number | null = null;
    if (online) {
      // Проверяем весь provider input до создания namespace на диске.
      trustedFullName = normalizeGitHubRepositoryFullName(repositoryFullName);
      updatedAtMs = now();
      if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs <= 0) {
        fail('github_metadata_invalid', 'GitHub account metadata получила неверный timestamp.');
      }
    }
    const accountDir = await accountNamespace(root, trustedAccountRef, {
      create: online,
    });
    const metadataFile = path.join(accountDir, 'account.json');

    if (online) {
      const stored = await readJsonNoFollow(metadataFile, {
        missing: null,
        maxBytes: 64 * 1024,
        privateFile: true,
      });
      if (stored) {
        // Rename разрешён только внутри уже доказанного immutable owner. Corrupt
        // или чужой account.json нельзя молча переписать поверх существующих stores.
        metadata(stored.data, {
          accountRef: trustedAccountRef,
          repositoryId: trustedRepositoryId,
        });
      }
      await atomicWriteJson(metadataFile, {
        schemaVersion: 1,
        channel: 'github',
        accountRef: trustedAccountRef,
        repositoryId: trustedRepositoryId,
        repositoryFullName: trustedFullName,
        updatedAtMs,
      }, { mode: 0o600 });
    } else {
      const stored = await readJsonNoFollow(metadataFile, {
        missing: null,
        maxBytes: 64 * 1024,
        privateFile: true,
      });
      if (!stored) {
        fail(
          'github_metadata_missing',
          'Для выбранного GitHub account нет проверенного repository metadata.',
        );
      }
      trustedFullName = metadata(stored.data, {
        accountRef: trustedAccountRef,
        repositoryId: trustedRepositoryId,
      }).repositoryFullName;
    }

    const refCodec = new InboxRefCodec({ channel: 'github', accountRef: trustedAccountRef });
    return {
      repositoryId: trustedRepositoryId,
      repositoryFullName: trustedFullName,
      archive: new GitHubArchiveStore({
        dir: accountDir,
        accountRef: trustedAccountRef,
        repositoryId: trustedRepositoryId,
      }),
      rules: new GitHubRulesStore({
        file: path.join(accountDir, 'rules.json'),
        accountRef: trustedAccountRef,
        repositoryId: trustedRepositoryId,
        now,
      }),
      inboxState: new InboxStateStore({
        file: path.join(accountDir, 'inbox-state.json'),
        channel: 'github',
        accountRef: trustedAccountRef,
        refCodec,
        activationCodec: githubActivationCodec,
      }),
      ingressState: new GitHubIngressStateStore({
        file: path.join(accountDir, 'ingress-state.json'),
        accountRef: trustedAccountRef,
        repositoryId: trustedRepositoryId,
        now,
      }),
    };
  };
}
