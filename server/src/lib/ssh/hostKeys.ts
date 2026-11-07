import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { errorCode } from '../../../../shared/lib/errors.ts';

import { SshFailure } from './failure.ts';

export interface HostKey {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

export interface TrustedHostKey extends HostKey {
  trustedAt: string;
}

// Что именно решает человек. `trusted` не спрашивает ничего, а замена известного
// ключа и первое знакомство с сервером — разные вопросы с разными ответами.
export interface HostKeyCheck {
  status: 'trusted' | 'unknown' | 'changed';
  decision: 'accepted' | 'trust_required' | 'replace_required';
  challengeId?: string;
  previous?: TrustedHostKey;
  current: HostKey;
}

export interface HostKeyStoreOptions {
  file: string;
  now?: () => number;
  challengeTtlMs?: number;
}

export interface HostKeyStore {
  check: (current: HostKey) => Promise<HostKeyCheck>;
  decide: (challengeId: string, decision: string) => Promise<{ ok: true; hostKey: TrustedHostKey }>;
  get: (host: string, port: number) => TrustedHostKey | null;
}

interface HostKeyChallenge {
  challengeId: string;
  canonical: string;
  current: HostKey;
  previous: TrustedHostKey | null;
  status: 'unknown' | 'changed';
  expiresAt: number;
}

function keyOf(host: string, port: number): string {
  return `${String(host).trim().toLowerCase()}:${Number(port) || 22}`;
}

/**
 * Known-hosts использует одноразовые короткоживущие challenges. Сам check ничего
 * не принимает молча: новое и изменившееся значение ждут отдельного решения.
 */
export async function createHostKeyStore(options: HostKeyStoreOptions): Promise<HostKeyStore> {
  const file = options.file;
  const now = options.now || Date.now;
  const challengeTtlMs = options.challengeTtlMs || 5 * 60 * 1000;
  const challenges = new Map<string, HostKeyChallenge>();
  let known: Record<string, TrustedHostKey> = {};
  try {
    known = (JSON.parse(await fs.readFile(file, 'utf8')) || {}) as Record<string, TrustedHostKey>;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }

  async function persist(): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(file), 0o700);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(known, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, file);
  }

  async function check(current: HostKey): Promise<HostKeyCheck> {
    const canonical = keyOf(current.host, current.port);
    const normalized = {
      host: String(current.host),
      port: Number(current.port) || 22,
      algorithm: String(current.algorithm || ''),
      fingerprint: String(current.fingerprint || ''),
    };
    const previous = known[canonical] || null;
    if (previous
      && previous.algorithm === normalized.algorithm
      && previous.fingerprint === normalized.fingerprint) {
      return { status: 'trusted', decision: 'accepted', current: normalized };
    }
    const challengeId = randomUUID();
    const status: 'unknown' | 'changed' = previous ? 'changed' : 'unknown';
    challenges.set(challengeId, {
      challengeId,
      canonical,
      current: normalized,
      previous,
      status,
      expiresAt: Number(now()) + challengeTtlMs,
    });
    return {
      status,
      decision: previous ? 'replace_required' : 'trust_required',
      challengeId,
      previous: previous ? structuredClone(previous) : undefined,
      current: structuredClone(normalized),
    };
  }

  async function decide(
    challengeIdValue: string,
    decision: string,
  ): Promise<{ ok: true; hostKey: TrustedHostKey }> {
    const challengeId = String(challengeIdValue || '');
    const challenge = challenges.get(challengeId);
    challenges.delete(challengeId);
    if (!challenge || challenge.expiresAt <= Number(now())) {
      throw new SshFailure('challenge_not_found', 'challenge expired or not_found');
    }
    const expected = challenge.status === 'changed' ? 'replace' : 'trust';
    if (decision !== expected) {
      throw new SshFailure('invalid_decision', `challenge требует решения ${expected}`);
    }
    const hostKey: TrustedHostKey = {
      ...challenge.current,
      trustedAt: new Date(Number(now())).toISOString(),
    };
    known[challenge.canonical] = hostKey;
    await persist();
    return { ok: true, hostKey: structuredClone(hostKey) };
  }

  return {
    check,
    decide,
    get: (host: string, port: number) => structuredClone(known[keyOf(host, port)] || null),
  };
}

export default createHostKeyStore;
