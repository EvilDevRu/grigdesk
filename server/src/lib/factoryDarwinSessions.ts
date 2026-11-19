import { readDarwinProcessCensus, type DarwinProcessCensusEntry }
  from '../../../shared/node/processIdentity.ts';
import type { FactoryProcessState } from '../../../shared/runtime/factoryOwnership.ts';

type SessionLeader = Pick<DarwinProcessCensusEntry, 'pid' | 'sid' | 'pgid' | 'starttime'>;

export interface DarwinSessionProof {
  state: FactoryProcessState;
  members: DarwinProcessCensusEntry[];
}

/**
 * Число SID без живого якоря не связывает прежнего владельца с участниками.
 * После выхода лидера якорем может быть участник ранее доказанного снимка.
 */
export function classifyDarwinSession(leader: SessionLeader, rows: DarwinProcessCensusEntry[],
  anchors: readonly DarwinProcessCensusEntry[] = [], recordedThisBoot = false): DarwinSessionProof {
  const currentLeader = rows.find((row) => row.pid === leader.pid);
  const members = rows.filter((row) => row.sid === leader.sid);

  if (currentLeader && (currentLeader.starttime !== leader.starttime
    || currentLeader.sid !== leader.sid || currentLeader.pgid !== leader.pgid)) {
    return { state: 'unknown', members: [] };
  }

  if (members.length === 0) {
    return { state: 'dead', members: [] };
  }

  const anchored = recordedThisBoot || currentLeader || members.some((member) => anchors.some((anchor) =>
    anchor.sid === leader.sid && anchor.pid === member.pid && anchor.starttime === member.starttime));

  return anchored && members.every((row) => BigInt(row.starttime) >= BigInt(leader.starttime))
    ? { state: 'alive', members }
    : { state: 'unknown', members: [] };
}

/**
 * Доказывает наличие сессии через точный процесс. Пустой снимок перепроверяет.
 * Ошибка helper или расхождение после первого отсутствия оставляют unknown.
 */
export async function inspectDarwinSession(leader: SessionLeader, readCensus = readDarwinProcessCensus,
  anchors: readonly DarwinProcessCensusEntry[] = [], recordedThisBoot = false): Promise<DarwinSessionProof> {
  try {
    const signal = AbortSignal.timeout(4500);
    const first = classifyDarwinSession(leader, await readCensus(signal), anchors, recordedThisBoot);

    if (first.state !== 'dead') {
      return first;
    }

    const second = classifyDarwinSession(leader, await readCensus(signal), anchors, recordedThisBoot);

    if (second.state === 'dead') {
      return second;
    }
  } catch {
    // Штатные callers используют unknown для отказа без побочных эффектов.
  }

  return { state: 'unknown', members: [] };
}
