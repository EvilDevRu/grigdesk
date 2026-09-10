// Сериализация ходов одновременно по chatKey и provider/sessionId. Два разных чата,
// ошибочно связанных с одной provider-сессией, не могут продолжить её параллельно.

// Что сериализуем: чат и, если известна, provider-сессия того же хода.
export interface TurnScope {
  chatKey?: unknown;
  provider?: unknown;
  sessionId?: unknown;
}

function clean(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || '';
}

export function turnLockKeys({ chatKey, provider, sessionId }: TurnScope = {}): string[] {
  const keys: string[] = [];
  const chat = clean(chatKey);
  const prov = clean(provider);
  const session = clean(sessionId);
  if (chat) keys.push(`chat:${chat}`);
  if (prov && session) keys.push(`session:${prov}:${session}`);
  return [...new Set(keys)].sort();
}

export class ChatTurnLocks {
  private tails: Map<string, Promise<void>>;

  constructor() {
    this.tails = new Map();
  }

  isBusy(scope: TurnScope): boolean {
    return turnLockKeys(scope).some((key) => this.tails.has(key));
  }

  async run<Value>(scope: TurnScope, job: () => Promise<Value>): Promise<Value> {
    const keys = turnLockKeys(scope);
    if (!keys.length) return job();
    const waits = keys.map((key) => this.tails.get(key) ?? Promise.resolve());
    const next = Promise.all(waits).then(job, job);
    const settled = next.then(() => {}, () => {});
    for (const key of keys) this.tails.set(key, settled);
    settled.then(() => {
      for (const key of keys) if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return next;
  }
}
