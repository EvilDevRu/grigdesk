import type { UiToastDismissReason, UiToastTone } from '../ui';
import type { AlertTarget } from './alertTargets.ts';

export const ALERT_HISTORY_LIMIT = 50;

/**
 * live — тост на экране; missed — тост ушёл сам, а человек его не тронул; seen — человек
 * закрыл тост, нажал действие или открыл историю; resolved — повод исчез (ответили, открыли чат).
 */
export type AlertHistoryState = 'live' | 'missed' | 'seen' | 'resolved';

export interface AlertHistoryEntry {
  readonly key: string;
  readonly id: string;
  readonly scope: string;
  readonly tone: UiToastTone;
  readonly title: string;
  readonly body: string;
  readonly target: AlertTarget | null;
  readonly at: number;
  readonly state: AlertHistoryState;
}

export interface AlertHistoryRecord {
  id: string;
  title: string;
  scope?: string;
  tone?: UiToastTone;
  body?: string;
  target?: AlertTarget;
}

export type AlertHistoryListener = (entries: readonly AlertHistoryEntry[]) => void;

export interface AlertHistory {
  record(input: AlertHistoryRecord): AlertHistoryEntry;
  toastGone(id: string, reason: UiToastDismissReason): void;
  resolve(id: string): void;
  resolveScope(scope: string): void;
  markSeen(key?: string): void;
  clear(): void;
  find(key: string): AlertHistoryEntry | null;
  list(): readonly AlertHistoryEntry[];
  missedCount(): number;
  subscribe(listener: AlertHistoryListener): () => void;
}

const GONE_STATE: Record<UiToastDismissReason, AlertHistoryState> = {
  timeout: 'missed',
  overflow: 'missed',
  user: 'seen',
  action: 'seen',
  program: 'resolved',
};

/**
 * История оповещений одного окна: новейшие первыми, не больше ALERT_HISTORY_LIMIT.
 * Живёт в памяти вкладки — в ней текст переписки, поэтому на диск она не пишется.
 */
export function createAlertHistory(now: () => number = Date.now): AlertHistory {
  let entries: AlertHistoryEntry[] = [];
  let sequence = 0;
  const listeners = new Set<AlertHistoryListener>();

  function emit(): void {
    const snapshot = Object.freeze([...entries]);

    listeners.forEach((listener) => listener(snapshot));
  }

  /**
   * Меняет состояние подходящих записей и публикует снимок, только если что-то изменилось:
   * частые вызовы гашения (каждый показ чата) не должны будить подписчиков впустую.
   */
  function update(
    matches: (entry: AlertHistoryEntry) => boolean,
    next: AlertHistoryState,
  ): void {
    let changed = false;

    entries = entries.map((entry) => {
      if (!matches(entry) || entry.state === next) {
        return entry;
      }

      changed = true;

      return Object.freeze({
        ...entry,
        state: next,
      });
    });

    if (changed) {
      emit();
    }
  }

  return {
    /**
     * Новое событие с тем же id заменяет тост на экране: прежняя живая запись уже
     * показывалась человеку и становится просмотренной.
     */
    record(input: AlertHistoryRecord): AlertHistoryEntry {
      sequence += 1;

      const entry: AlertHistoryEntry = Object.freeze({
        key: `${input.id}#${sequence}`,
        id: input.id,
        scope: String(input.scope ?? ''),
        tone: input.tone || 'accent',
        title: input.title,
        body: String(input.body ?? ''),
        target: input.target ? Object.freeze({ ...input.target }) : null,
        at: now(),
        state: 'live',
      });

      entries = entries.map((item) => (
        item.id === input.id && item.state === 'live'
          ? Object.freeze({
            ...item,
            state: 'seen' as const,
          })
          : item
      ));
      entries = [entry, ...entries].slice(0, ALERT_HISTORY_LIMIT);
      emit();

      return entry;
    },
    toastGone(id: string, reason: UiToastDismissReason): void {
      const live = entries.find((entry) => entry.id === id && entry.state === 'live');

      if (live) {
        update((entry) => entry === live, GONE_STATE[reason] ?? 'seen');
      }
    },
    resolve(id: string): void {
      update((entry) => entry.id === id && (entry.state === 'live' || entry.state === 'missed'),
        'resolved');
    },
    resolveScope(scope: string): void {
      if (!scope) {
        return;
      }

      update((entry) => entry.scope === scope
        && (entry.state === 'live' || entry.state === 'missed'), 'resolved');
    },
    markSeen(key?: string): void {
      update((entry) => entry.state === 'missed' && (!key || entry.key === key), 'seen');
    },
    clear(): void {
      if (entries.length) {
        entries = [];
        emit();
      }
    },
    find(key: string): AlertHistoryEntry | null {
      return entries.find((entry) => entry.key === key) ?? null;
    },
    list(): readonly AlertHistoryEntry[] {
      return Object.freeze([...entries]);
    },
    missedCount(): number {
      return entries.filter((entry) => entry.state === 'missed').length;
    },
    subscribe(listener: AlertHistoryListener): () => void {
      listeners.add(listener);
      listener(Object.freeze([...entries]));

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
