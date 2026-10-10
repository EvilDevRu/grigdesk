import { createHash } from 'node:crypto';

export type FactoryMobileIdentity = {
  profile: string;
  attempt: string;
  node: string | null;
  state: string;
  stop: string | null;
  sequence: number;
  headEventHash: string;
  orchPid: number;
  terminal: string | null;
};

type Trusted = {
  profile?: string;
  attempt?: string;
  terminal?: string | null;
  cursor?: {
    node: string | null;
    state: string;
    stop: string | null;
  } | null;
  stageIdentity?: {
    sequence: number;
    headEventHash: string;
  } | null;
};

/**
 * Identity берётся из проверенного runtime envelope, а не из статусов UI-проекции.
 * Без точной revision действие не предлагается, даже если старый реестр рисует ворота.
 */
export function factoryMobileIdentity(trusted: Trusted, registry: { ORCH_PID?: unknown }) {
  const stage = trusted.stageIdentity;

  if (!trusted.profile || !trusted.attempt || !stage || !trusted.cursor) {
    return null;
  }

  return {
    profile: trusted.profile,
    attempt: trusted.attempt,
    node: trusted.cursor.node,
    state: trusted.cursor.state,
    stop: trusted.cursor.stop,
    sequence: stage.sequence,
    headEventHash: stage.headEventHash,
    orchPid: Number(registry.ORCH_PID) || 0,
    terminal: trusted.terminal ?? null,
  } satisfies FactoryMobileIdentity;
}

/**
 * Канонический fingerprint снимка не зависит от порядка полей JSON.
 * Hash включает весь launch-options, в том числе профиль, runners, scope и required параметры.
 */
export function factorySnapshotHash(value: unknown): string {
  /**
   * Рекурсивная сортировка затрагивает ключи объектов, сохраняя порядок массивов.
   * Вложенные options и constraints входят в тот же fingerprint прочитанного снимка.
   */
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(canonical);
    }
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }

    return item;
  };

  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/**
 * Сверка охватывает каждый компонент exact identity, включая PID и journal head.
 * Лишние или отсутствующие поля не превращаются в частичную проверку attempt.
 */
export function sameFactoryIdentity(expected: unknown, current: FactoryMobileIdentity | null) {
  return current !== null && factorySnapshotHash(expected) === factorySnapshotHash(current);
}
