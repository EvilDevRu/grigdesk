import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

function keyOf(host, port) {
  return `${String(host).trim().toLowerCase()}:${Number(port) || 22}`;
}

/**
 * Known-hosts использует одноразовые короткоживущие challenges. Сам check ничего
 * не принимает молча: новое и изменившееся значение ждут отдельного решения.
 */
export async function createHostKeyStore(options = {}) {
  const file = options.file;
  const now = options.now || Date.now;
  const challengeTtlMs = options.challengeTtlMs || 5 * 60 * 1000;
  const challenges = new Map();
  let known = {};
  try {
    known = JSON.parse(await fs.readFile(file, 'utf8')) || {};
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  async function persist() {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(file), 0o700);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(known, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, file);
  }

  async function check(current) {
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
    const status = previous ? 'changed' : 'unknown';
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

  async function decide(challengeIdValue, decision) {
    const challengeId = String(challengeIdValue || '');
    const challenge = challenges.get(challengeId);
    challenges.delete(challengeId);
    if (!challenge || challenge.expiresAt <= Number(now())) {
      const error = new Error('challenge expired or not_found');
      error.code = 'challenge_not_found';
      throw error;
    }
    const expected = challenge.status === 'changed' ? 'replace' : 'trust';
    if (decision !== expected) {
      const error = new Error(`challenge требует решения ${expected}`);
      error.code = 'invalid_decision';
      throw error;
    }
    known[challenge.canonical] = {
      ...challenge.current,
      trustedAt: new Date(Number(now())).toISOString(),
    };
    await persist();
    return { ok: true, hostKey: structuredClone(known[challenge.canonical]) };
  }

  return {
    check,
    decide,
    get: (host, port) => structuredClone(known[keyOf(host, port)] || null),
  };
}

export default createHostKeyStore;
