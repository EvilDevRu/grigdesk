import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

import {
  darwinProcessOwnerState, readDarwinBootId, readDarwinProcessIdentity,
  signalDarwinBuildMember, type DarwinProcessIdentity,
} from '../../../../shared/node/processIdentity.ts';
import { privateRuntimeDirectory, syncRuntimeDirectory, writeRuntimeJson } from '../../binary/leases.ts';
import { readDarwinControlText, readDarwinRunnerBinding, type DarwinRunnerBinding } from '../factoryDarwinRunnerState.ts';
import { inspectDarwinSession } from '../factoryDarwinSessions.ts';

export interface DarwinProviderIdentity {
  pid: number;
  sid: number;
  pgid: number;
  starttime: string;
}

export interface DarwinProviderRecord {
  format: 1;
  task: string;
  stage: string;
  run: string;
  epoch: string;
  boot: string;
  runner: DarwinProviderIdentity;
  owner: DarwinProviderIdentity;
  child: DarwinProviderIdentity | null;
}

function identity(process: DarwinProviderIdentity) {
  return { pid: process.pid, sid: process.sid, pgid: process.pgid, starttime: process.starttime };
}

export const darwinProviderFile = /^t([1-9][0-9]{0,18})\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/u;

function validIdentity(value: DarwinProviderIdentity | null): value is DarwinProviderIdentity {
  return !!value && [value.pid, value.sid, value.pgid].every((id) => Number.isSafeInteger(id) && id > 0)
    && typeof value.starttime === 'string' && /^\d{7,26}$/u.test(value.starttime);
}

/** Удерживает unreadable, partial или конфликтующий provider как неизвестный. */
export async function readDarwinExternalProviders(control: string, task: string, binding: DarwinRunnerBinding | null) {
  const directory = path.join(control, 'external-provider-processes');

  await privateRuntimeDirectory(directory, false);

  const rows = [];

  for (const name of await fs.readdir(directory)) {
    if (!name.startsWith(`t${task}.`)) {
      continue;
    }
    if (!binding || !darwinProviderFile.test(name)) {
      throw new Error('release_activity_unknown');
    }

    const file = path.join(directory, name);
    const text = await readDarwinControlText(file);
    const row = JSON.parse(text) as DarwinProviderRecord | null;
    const shape = 'boot,child,epoch,format,owner,run,runner,stage,task';

    if (!row || Object.keys(row).sort().join(',') !== shape || row.format !== 1 || row.task !== task
      || row.stage !== binding.stage || row.run !== binding.runId || row.epoch !== binding.epoch
      || !validIdentity(row.runner) || !validIdentity(row.owner) || row.runner.sid !== binding.sid
      || row.runner.starttime !== binding.starttime || row.runner.pid !== binding.pid
      || row.runner.pgid !== binding.pgid || row.owner.sid !== binding.sid
      || typeof row.boot !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(row.boot)
      || row.child !== null && (!validIdentity(row.child) || row.child.pid !== row.child.sid
        || row.child.pgid !== row.child.sid || row.child.sid === binding.sid)) {
      throw new Error('release_activity_unknown');
    }

    rows.push({ file, row, text });
  }

  return rows;
}

/**
 * После quiescence раннера завершает подтверждённые отдельные сессии CLI.
 * Записи снимаются только после проверки их прежних bytes под engine lock.
 */
export async function quiesceDarwinExternalProviders(control: string, task: string,
  binding: DarwinRunnerBinding, signal: AbortSignal): Promise<void> {
  const records = await readDarwinExternalProviders(control, task, binding);
  const boot = records.length > 0 ? await readDarwinBootId() : '';

  for (const { row, file, text } of records) {
    if (row.boot === boot) {
      if (await darwinProcessOwnerState(row.owner) !== 'dead') {
        throw new Error('release_activity_unknown');
      }

      if (row.child) {
        const until = performance.now() + 2400;

        for (;;) {
          signal.throwIfAborted();
          const session = await inspectDarwinSession(row.child, undefined, [], true);

          if (session.state === 'dead') {
            break;
          }
          if (session.state !== 'alive' || await readDarwinControlText(file) !== text) {
            throw new Error('release_activity_unknown');
          }

          await Promise.all(session.members.map((member) =>
            signalDarwinBuildMember(member, performance.now() > until ? 'KILL' : 'TERM', signal)));
          await pause(100, undefined, { signal });
        }
      }
    }

    if (await readDarwinControlText(file) !== text) {
      throw new Error('release_activity_unknown');
    }

    await fs.unlink(file);
    await syncRuntimeDirectory(path.dirname(file));
  }
}

/**
 * Helper публикует intent до появления wrapper. Отсутствие child означает,
 * что held child ещё не получал permit. Scope берётся из checked runner binding.
 */
export async function reserveDarwinExternalProvider(owner: DarwinProcessIdentity) {
  const task = process.env.FACTORY_RUN_TASK ?? '';
  const stage = process.env.FACTORY_RUN_STAGE ?? '';
  const run = process.env.FACTORY_RUN_ID ?? '';
  const epoch = process.env.FACTORY_RUN_EPOCH ?? '';

  if (!task && !stage && !run && !epoch) {
    return null;
  }

  const control = process.env.FACTORY_CONTROL_ROOT ?? '';

  if (!path.isAbsolute(control) || !/^[1-9][0-9]{0,18}$/u.test(task)) {
    throw new Error('darwin_external_provider_scope_invalid');
  }

  const runner = await readDarwinRunnerBinding(control, task);

  if (!runner || runner.stage !== stage || runner.runId !== run || runner.epoch !== epoch
    || runner.sid !== owner.sid || owner.pid === runner.pid) {
    throw new Error('darwin_external_provider_scope_invalid');
  }

  const directory = path.join(control, 'external-provider-processes');

  await privateRuntimeDirectory(directory, false);

  const file = path.join(directory, `t${task}.${randomUUID()}.json`);
  const record: DarwinProviderRecord = {
    format: 1,
    task,
    stage,
    run,
    epoch,
    boot: await readDarwinBootId(),
    owner: identity(owner),
    runner: identity(runner),
    child: null,
  };

  await writeRuntimeJson(file, record);

  return {
    /** Закрепляет владельца отдельной сессии до единственного байта permit. */
    async bind(child: DarwinProcessIdentity) {
      record.child = identity(child);
      await writeRuntimeJson(file, record);
    },
    /** Не снимает запись при неизвестном census или незавершённой сессии. */
    async release() {
      if (record.child && (await inspectDarwinSession(record.child, undefined, [], true)).state !== 'dead') {
        throw new Error('darwin_external_provider_active');
      }

      await fs.unlink(file);
      await syncRuntimeDirectory(directory);
    },
  };
}

/**
 * PID wrapper становится достаточной identity только после создания своей
 * сессии и подтверждения PPID от helper, который удерживает permit.
 */
export async function waitDarwinExternalProvider(pid: number, signal: AbortSignal) {
  while (!signal.aborted) {
    const probe = await readDarwinProcessIdentity(pid);

    if (probe.state === 'alive' && probe.identity.pid === probe.identity.pgid
      && probe.identity.pid === probe.identity.sid && probe.identity.ppid === process.pid) {
      return probe.identity;
    }

    await pause(30, undefined, { signal });
  }

  throw new Error('darwin_external_provider_scope_invalid');
}
