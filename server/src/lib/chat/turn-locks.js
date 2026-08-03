// Сериализация ходов одновременно по chatKey и provider/sessionId. Два разных чата,
// ошибочно связанных с одной provider-сессией, не могут продолжить её параллельно.

function clean(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || '';
}

export function turnLockKeys({ chatKey, provider, sessionId } = {}) {
  const keys = [];
  const chat = clean(chatKey);
  const prov = clean(provider);
  const session = clean(sessionId);
  if (chat) keys.push(`chat:${chat}`);
  if (prov && session) keys.push(`session:${prov}:${session}`);
  return [...new Set(keys)].sort();
}

export class ChatTurnLocks {
  constructor() {
    this.tails = new Map();
  }

  isBusy(scope) {
    return turnLockKeys(scope).some((key) => this.tails.has(key));
  }

  async run(scope, job) {
    const keys = turnLockKeys(scope);
    if (!keys.length) return job();
    const waits = keys.map((key) => this.tails.get(key) || Promise.resolve());
    const next = Promise.all(waits).then(job, job);
    const settled = next.then(() => {}, () => {});
    for (const key of keys) this.tails.set(key, settled);
    settled.then(() => {
      for (const key of keys) if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return next;
  }
}
