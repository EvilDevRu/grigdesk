import { factorySnapshotHash } from '../../../../shared/node/factorySnapshotHash.ts';

export { factorySnapshotHash } from '../../../../shared/node/factorySnapshotHash.ts';

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
 * Сверка охватывает каждый компонент exact identity, включая PID и journal head.
 * Лишние или отсутствующие поля не превращаются в частичную проверку attempt.
 */
export function sameFactoryIdentity(expected: unknown, current: FactoryMobileIdentity | null) {
  return current !== null && factorySnapshotHash(expected) === factorySnapshotHash(current);
}

/**
 * Отдельная identity подготовительной фазы не использует sequence главного cursor.
 * PID и bootstrap visit/decision связывают stop/resume с прочитанной попыткой.
 */
export function factoryPreludeIdentity(trusted: {
    profile?: string;
    attempt?: string;
    terminal?: string | null;
    cursor?: unknown;
    bootstrapStop?: {
        visitId: string;
        recordHash: string;
        state: string;
        decision: { recordHash: string } | null;
    } | null;
}, registry: { ORCH_PID?: unknown }) {
    if (!trusted.profile || !trusted.attempt || trusted.cursor || trusted.terminal) {
        return null;
    }

    const stop = trusted.bootstrapStop;

    return {
        profile: trusted.profile,
        attempt: trusted.attempt,
        orchPid: Number(registry.ORCH_PID) || 0,
        bootstrap: stop ? {
            visitId: stop.visitId,
            stopHash: stop.recordHash,
            state: stop.state,
            decisionHash: stop.decision?.recordHash ?? null,
        } : null,
    };
}
