import {
  browserAuthorityError, parseBrowserRunProof, readBrowserBinding, readBrowserRun,
  removeBrowserBinding, writeBrowserBinding,
} from './factoryBrowserBinding.ts';

import type {
  BrowserProcesses, BrowserRun, BrowserRunBinding, BrowserRunProof,
} from './factoryBrowserBinding.ts';
import type { TrustedBrowserAttempt } from './factoryBrowserTrusted.ts';

export interface FactoryBrowserAuthority {
  controlRoot: string;
  trusted(task: string): Promise<TrustedBrowserAttempt>;
  processes?: BrowserProcesses;
}

/**
 * Binding не может склеить новый cursor со старым активным процессом.
 * Все stable части run и pinned attempt должны совпасть до возврата owner.
 */
function matches(binding: BrowserRunBinding, run: BrowserRun, trusted: TrustedBrowserAttempt,
  proof: BrowserRunProof,
): boolean {
  return binding.task === proof.task && binding.stage === proof.stage
    && binding.attemptId === proof.attemptId && trusted.attempt === proof.attemptId
    && trusted.task === proof.task && trusted.runKey === proof.stage
    && binding.profile === trusted.profile && binding.catalogHash === trusted.catalogHash
    && binding.route === trusted.route && binding.routeHash === trusted.routeHash
    && binding.node === trusted.node && binding.sequence === trusted.sequence
    && binding.headEventHash === trusted.headEventHash
    && binding.runId === run.runId && binding.epoch === run.epoch
    && binding.tokenHash === run.tokenHash && binding.runner === run.runner
    && binding.pid === run.pid && binding.pgid === run.pgid && binding.session === run.session
    && binding.starttime === run.starttime && binding.bootId === run.bootId;
}

/**
 * Каждый authorize читает текущие protected записи и живой процесс повторно.
 * Разрешение не кешируется по owner; неизменный proof принадлежит одной команде.
 */
export async function factoryBrowserOwner(port: FactoryBrowserAuthority, raw: unknown) {
  const proof = parseBrowserRunProof(raw);
  const first = await readBrowserRun(port.controlRoot, proof, port.processes);
  const binding = await readBrowserBinding(port.controlRoot, proof);
  const trusted = await port.trusted(proof.task);
  const second = await readBrowserRun(port.controlRoot, proof, port.processes);
  const again = await port.trusted(proof.task);
  const latestBinding = await readBrowserBinding(port.controlRoot, proof);
  const last = await readBrowserRun(port.controlRoot, proof, port.processes);

  if (first.identity !== second.identity || second.identity !== last.identity
    || trusted.identity !== again.identity
    || JSON.stringify(binding) !== JSON.stringify(latestBinding)
    || !matches(binding, first, trusted, proof) || !matches(latestBinding, last, again, proof)) {
    return browserAuthorityError();
  }

  return {
    kind: 'task' as const,
    key: proof.task,
    projectId: trusted.profile,
    attemptId: proof.attemptId,
  };
}

/**
 * Publisher сам выводит visit и pinned identity из protected источников.
 * Пока запись не подтверждена повторной проверкой, provider остаётся на launch barrier.
 */
export async function publishFactoryBrowserBinding(port: FactoryBrowserAuthority, raw: unknown) {
  const proof = parseBrowserRunProof(raw);
  const first = await readBrowserRun(port.controlRoot, proof, port.processes);
  const trusted = await port.trusted(proof.task);
  const second = await readBrowserRun(port.controlRoot, proof, port.processes);
  const again = await port.trusted(proof.task);

  if (first.identity !== second.identity || trusted.identity !== again.identity
    || trusted.attempt !== proof.attemptId || again.attempt !== proof.attemptId
    || trusted.runKey !== proof.stage || again.runKey !== proof.stage) {
    return browserAuthorityError();
  }

  const binding: BrowserRunBinding = {
    schema: 1,
    task: proof.task,
    stage: proof.stage,
    attemptId: proof.attemptId,
    profile: trusted.profile,
    catalogHash: trusted.catalogHash,
    route: trusted.route,
    routeHash: trusted.routeHash,
    node: trusted.node,
    sequence: trusted.sequence,
    headEventHash: trusted.headEventHash,
    runId: first.runId,
    epoch: first.epoch,
    tokenHash: first.tokenHash,
    runner: first.runner,
    pid: first.pid,
    pgid: first.pgid,
    session: first.session,
    starttime: first.starttime,
    bootId: first.bootId,
  };

  await writeBrowserBinding(port.controlRoot, binding);

  try {
    await factoryBrowserOwner(port, proof);
  } catch (error) {
    await removeBrowserBinding(port.controlRoot, proof);

    throw error;
  }
}
