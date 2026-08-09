import fs from 'node:fs';

function processStatStartTime(contents) {
  // comm заключён в скобки и сам может содержать пробелы/скобки. После последней `)`
  // начинается field 3; starttime — field 22, то есть индекс 19 в этом хвосте.
  const end = contents.lastIndexOf(')');
  if (end < 0) return null;
  const fields = contents.slice(end + 2).trim().split(/\s+/);
  return fields[19] || null;
}

export function readProcessIdentity(pid, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0').filter(Boolean).join(' ');
    const starttime = processStatStartTime(stat);
    if (!starttime || !cmdline) return null;
    return { pid, starttime, cmdline };
  } catch {
    return null;
  }
}

export function captureProcessIdentity(pid, { script, nonce } = {}, deps = {}) {
  if (typeof script !== 'string' || !script || typeof nonce !== 'string' || !nonce) return null;
  const actual = (deps.readProcessIdentity || readProcessIdentity)(pid);
  if (!actual || !actual.cmdline.includes(script) || !actual.cmdline.includes(nonce)) return null;
  return { ...actual, script, nonce };
}

/** PID одного недостаточно: номер мог уже достаться постороннему процессу. */
export function processIdentityMatches(expected, deps = {}) {
  if (!expected
    || !Number.isInteger(expected.pid)
    || typeof expected.starttime !== 'string'
    || typeof expected.cmdline !== 'string'
    || typeof expected.script !== 'string'
    || !expected.script
    || typeof expected.nonce !== 'string'
    || !expected.nonce) return false;
  const actual = (deps.readProcessIdentity || readProcessIdentity)(expected.pid);
  return Boolean(actual
    && actual.pid === expected.pid
    && actual.starttime === expected.starttime
    && actual.cmdline === expected.cmdline
    && actual.cmdline.includes(expected.script)
    && actual.cmdline.includes(expected.nonce));
}

export function signalOwnedProcess(identity, signal, deps = {}) {
  if (!processIdentityMatches(identity, deps)) return false;
  try {
    (deps.kill || process.kill)(identity.pid, signal);
    return true;
  } catch {
    return false;
  }
}
