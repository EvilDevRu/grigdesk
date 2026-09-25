import { RoutesStore } from './store.ts';

export interface CatalogObserverScheduler {
  setInterval(callback: () => Promise<void>, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultScheduler: CatalogObserverScheduler = {
  setInterval(callback, intervalMs) {
    const timer = setInterval(() => { void callback(); }, intervalMs);
    timer.unref();
    return timer;
  },
  clearInterval(handle) { clearInterval(handle as NodeJS.Timeout); },
};

interface Snapshot {
  catalogHash: string | null;
  sourceRevision: number;
}

/** Один timer на сервер для профилей, каталоги которых открывались клиентами. */
export class CatalogObserver {
  private readonly store: RoutesStore;

  private readonly broadcast: (profile: string, snapshot: Snapshot) => void;

  private readonly scheduler: CatalogObserverScheduler;

  private readonly onError: (error: unknown) => void;

  private readonly profiles = new Map<string, Snapshot>();

  private readonly registering = new Map<string, Promise<void>>();

  private timer: unknown = null;

  private polling: Promise<void> | null = null;

  private closed = false;

  constructor(store: RoutesStore,
    broadcast: (profile: string, snapshot: Snapshot) => void,
    { scheduler = defaultScheduler, onError = () => {} }: {
      scheduler?: CatalogObserverScheduler;
      onError?: (error: unknown) => void;
    } = {}) {
    this.store = store;
    this.broadcast = broadcast;
    this.scheduler = scheduler;
    this.onError = onError;
  }

  private async snapshot(profile: string): Promise<Snapshot> {
    const [current, source] = await Promise.all([
      this.store.readCurrent(profile), this.store.readEditorSource(profile),
    ]);
    return { catalogHash: current?.catalogHash ?? null, sourceRevision: source.revision };
  }

  async register(profile: string): Promise<void> {
    if (this.closed || this.profiles.has(profile)) return;
    const inflight = this.registering.get(profile);
    if (inflight) return inflight;
    const task = (async () => {
      const snapshot = await this.snapshot(profile);
      if (this.closed || this.profiles.has(profile)) return;
      this.profiles.set(profile, snapshot);
      if (this.timer === null) {
        this.timer = this.scheduler.setInterval(() => this.poll(), 2000);
      }
    })();
    this.registering.set(profile, task);
    try { await task; } finally { this.registering.delete(profile); }
  }

  note(profile: string, catalogHash: string | null, sourceRevision: number): void {
    if (this.profiles.has(profile)) {
      this.profiles.set(profile, { catalogHash, sourceRevision });
    }
  }

  poll(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.polling) return this.polling;
    const task = (async () => {
      for (const [profile, previous] of this.profiles) {
        try {
          const current = await this.snapshot(profile);
          if (this.closed) return;
          if (current.catalogHash !== previous.catalogHash
            || current.sourceRevision !== previous.sourceRevision) {
            this.profiles.set(profile, current);
            this.broadcast(profile, current);
          }
        } catch (error) {
          this.onError(error);
        }
      }
    })();
    this.polling = task;
    void task.then(
      () => { if (this.polling === task) this.polling = null; },
      (error) => {
        if (this.polling === task) this.polling = null;
        this.onError(error);
      },
    );
    return task;
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) this.scheduler.clearInterval(this.timer);
    this.timer = null;
    this.profiles.clear();
    this.registering.clear();
  }
}
