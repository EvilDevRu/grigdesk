import { setTimeout as pause } from 'node:timers/promises';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { signalDarwinBuildMember } from '../../../shared/node/processIdentity.ts';

import type { DarwinTaskRuntime } from './factoryDarwinInventory.ts';
import { readDarwinLaunchRecords } from './factoryDarwinLaunch.ts';
import { quiesceDarwinRunner } from './factoryDarwinRunnerState.ts';

type StopResult =
  | { ok: true; outcome: 'not_running' | 'stopped' }
  | { ok: false; error: 'release_activity_unknown' | 'release_task_cleanup_required' | 'release_drain_busy' };

type FinishStop = (identity: NonNullable<DarwinTaskRuntime['identity']>) => Promise<boolean>;

const unknown = { ok: false, error: 'release_activity_unknown' } as const;
const cleanup = { ok: false, error: 'release_task_cleanup_required' } as const;

/**
 * Продолжает очистку после подтверждённого завершения обеих сессий.
 * Успех команды требует независимого чтения той же попытки после записи.
 */
async function finishStop(runtime: DarwinTaskRuntime, inspect: () => Promise<DarwinTaskRuntime>,
  finalize: FinishStop, outcome: 'not_running' | 'stopped'): Promise<StopResult> {
  if (runtime.orchestrator !== 'dead' || runtime.runner !== 'dead') {
    return unknown;
  }
  if (runtime.finalization === 'done') {
    return { ok: true, outcome };
  }
  if (runtime.finalization !== 'pending' || !runtime.identity || !await finalize(runtime.identity)) {
    return cleanup;
  }

  const check = await inspect();
  const sameAttempt = check.identity?.attempt === runtime.identity.attempt
    && check.identity.profile === runtime.identity.profile;
  const complete = check.orchestrator === 'dead' && check.runner === 'dead' && check.finalization === 'done';

  return sameAttempt && complete ? { ok: true, outcome: 'stopped' } : cleanup;
}

/**
 * Stop macOS пользуется отдельным снимком и exact session leader.
 * Ошибка проверки в любой точке означает отказ без успешного ACK.
 */
export async function stopDarwinOrchestrator(controlRoot: string, task: string,
  inspect: () => Promise<DarwinTaskRuntime>, finalize: FinishStop): Promise<StopResult> {
  const signal = AbortSignal.timeout(12000);

  try {
    const bound = await inspect();

    if (bound.orchestrator === 'unknown' || bound.runner === 'unknown' || bound.finalization === 'unknown') {
      return unknown;
    }

    if (bound.orchestrator === 'dead') {
      if (bound.binding && bound.launch) {
        await quiesceDarwinRunner(controlRoot, task, bound.binding, bound.launch, signal);

        return await finishStop(await inspect(), inspect, finalize, 'stopped');
      }

      return await finishStop(bound, inspect, finalize, 'not_running');
    }

    if (!bound.launch?.process) {
      return unknown;
    }

    const current = await readDarwinLaunchRecords(controlRoot, task);

    if (!current.some((record) => canonicalJson(record) === canonicalJson(bound.launch))) {
      return unknown;
    }

    await signalDarwinBuildMember(bound.launch.process, 'TERM', signal);

    while (!signal.aborted) {
      const after = await inspect();

      if (after.orchestrator === 'unknown' || after.runner === 'unknown'
        || after.finalization === 'unknown'
        || after.launch && after.launch.launchId !== bound.launch.launchId) {
        return unknown;
      }

      if (after.orchestrator === 'dead' && after.runner === 'dead') {
        return await finishStop(after, inspect, finalize, 'stopped');
      }

      await pause(200, undefined, { signal });
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'release_drain_busy') {
      return { ok: false, error: 'release_drain_busy' };
    }
    if (error instanceof Error && error.message === cleanup.error) {
      return cleanup;
    }

    return unknown;
  }

  return unknown;
}
