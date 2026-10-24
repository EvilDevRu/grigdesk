import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';

import { dataHome } from '../shared/runtime/dataHome.ts';
import { openBuildLog, readBuildTimings, saveBuildTimings } from './buildLog.ts';
import { collectBuildProcesses, signalBuildProcesses } from './buildProcesses.ts';
import type { BuildProcess } from './buildProcesses.ts';
import { buildStepIds, estimateBuildProgress } from './buildState.ts';
import type { BuildStep } from './buildState.ts';
import { cliTranslator } from './i18n.ts';
import { showScreen } from './screen.ts';
import type { ScreenLine } from './screen.ts';
import { TerminalSession } from './terminal.ts';

interface ObservedStep extends BuildStep {
  startedAt?: number;
  code?: number;
}

function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Контроллер запускает прежнюю оболочку, читая отдельный канал фактических стадий.
 * Он владеет только своей группой и доказанными потомками, не трогая службы или окно.
 */
async function observeBuild(
  root: string, variant: string, session: TerminalSession, returnToMenu: boolean,
): Promise<number> {
  const { t } = cliTranslator();
  const input = { env: process.env, home: process.env.HOME || os.homedir() };
  let log: Awaited<ReturnType<typeof openBuildLog>>;

  try {
    log = await openBuildLog(input);
  } catch (error) {
    showScreen(session, {
      title: t('build'),
      state: { text: t('screens.failed', { code: 1 }), tone: 'error' },
      lines: [t('logError', { reason: (error as Error).message })],
      full: true,
    });

    return 1;
  }

  const ids = buildStepIds(variant);
  const historyInput = {
    dataHome: dataHome(input),
    variant,
    ids,
  };
  const previous = await readBuildTimings(historyInput);
  const steps: ObservedStep[] = ids.map((id, index) => ({
    id,
    weightMs: previous?.[index]?.durationMs,
    status: 'pending',
    elapsedMs: 0,
  }));
  const started = Date.now();
  const animated = process.env.TERM !== 'dumb';
  const tail: string[] = [];
  let lastLine = '';
  let previousPercent = 0;
  let frame = 0;
  let selectServer = false;
  let interrupted = 0;
  let cancellation: Promise<void> | undefined;
  let known: BuildProcess[] = [];
  let completed = false;
  let childCode = 1;
  let failure: string | undefined;
  const child = spawn('/bin/bash', [path.join(root, 'bin/grigdesk-ctl'),
    ...variant === 'bundle' ? ['bundle'] : ['build', variant]], {
    cwd: root,
    env: {
      ...process.env,
      GRIGDESK_CTL_BUILD_CHILD: '1',
      GRIGDESK_CTL_BUILD_OBSERVED: '1',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });

  /**
   * Перерисовка хранит только одну строку вывода и ограниченный хвост ошибки.
   * Даже все завершённые события не дают 100 до закрытия ребёнка и его потоков.
   */
  function render(succeeded = false): void {
    const elapsed = Date.now() - started;

    for (const step of steps) {
      if (step.status === 'running') {
        step.elapsedMs = Date.now() - step.startedAt!;
      }
    }

    const estimate = estimateBuildProgress({
      steps,
      elapsedMs: elapsed,
      previousPercent,
      succeeded,
    });

    previousPercent = estimate.percent;

    const lines: ScreenLine[] = [];

    for (const step of steps) {
      const marker = step.status === 'done' ? '✓' : step.status === 'failed' ? '✗'
        : step.status === 'running' ? ['◐', '◓', '◑', '◒'][frame % 4] : '○';

      lines.push({
        text: `${marker} ${t(`steps.${step.id}`)}  ${duration(step.elapsedMs)}`,
        tone: step.status === 'done' ? 'success' : step.status === 'failed' ? 'error'
          : step.status === 'running' ? 'accent' : 'muted',
      });
    }

    if (!steps.some((step) => step.status !== 'pending')) {
      lines.push({ text: `◒ ${t('preparing')}`, tone: 'accent' });
    }

    const width = Math.max(4, Math.min(30, session.columns - 12));
    const filled = Math.floor(width * estimate.percent / 100);

    lines.push({ text: '' });
    lines.push({
      text: `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${Math.floor(estimate.percent)}%`,
      tone: succeeded ? 'success' : 'accent',
    });
    lines.push({
      text: `${duration(elapsed)} / ≈ ${duration(elapsed + estimate.remainingMs)}`,
      tone: 'muted',
    });
    lines.push({ text: `› ${lastLine}`, tone: 'muted' });
    lines.push({ text: '' }, { text: t('log', { path: log.path }), tone: 'muted' });
    frame++;

    showScreen(session, {
      title: `${t('build')}: ${t(variant === 'server' ? 'serverOnly' : variant)}`,
      state: {
        text: t(succeeded ? 'screens.done' : 'screens.running'),
        tone: succeeded ? 'success' : 'accent',
      },
      lines,
      footer: t('screens.cancel'),
    });
  }

  /**
   * Снимок дерева снимается до первого сигнала, затем сохраняется до конца эскалации.
   * Ранний выход лидера не отменяет TERM/KILL для живых известных потомков.
   */
  async function cancel(code: number): Promise<void> {
    interrupted = code;

    if (!child.pid) {
      return;
    }

    known = await collectBuildProcesses(child.pid, known);
    await signalBuildProcesses(known, 'SIGINT');

    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      await pause(2000);
      known = await collectBuildProcesses(child.pid, known);
      await signalBuildProcesses(known, signal);
    }
  }

  const onInterrupt = (): void => {
    cancellation ??= cancel(130);
  };
  const onTerminate = (): void => {
    cancellation ??= cancel(143);
  };

  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  /**
   * Полные байты сохраняются с обратным давлением, экран декодируется отдельно.
   * Частичные UTF-8 и CR не теряются, память хвоста ограничена двадцатью строками.
   */
  async function capture(stream: Readable): Promise<void> {
    const decoder = new StringDecoder('utf8');
    let pending = '';

    for await (const chunk of stream) {
      await log.write(chunk);

      const text = pending + decoder.write(chunk);
      const lines = text.split(/[\r\n]/);

      pending = lines.pop()!.slice(-4096);

      for (const line of lines) {
        if (line) {
          tail.push(line.slice(-4096));
          lastLine = line.slice(-4096);
        }
      }

      tail.splice(0, Math.max(0, tail.length - 20));

      if (pending) {
        lastLine = pending;
      }
    }

    pending += decoder.end();

    if (pending) {
      tail.push(pending);
      tail.splice(0, Math.max(0, tail.length - 20));
      lastLine = pending;
    }
  }

  /**
   * События разбираются независимо от границ chunk и не попадают в журнал вывода.
   * Неизвестная стадия не может менять оценку или порядок утверждённой цепочки.
   * Терминал без очистки получает экран при смене стадии, без таймерной анимации.
   */
  async function events(stream: Readable): Promise<void> {
    let pending = '';

    for await (const chunk of stream) {
      pending += chunk.toString();

      while (pending.includes('\n')) {
        const end = pending.indexOf('\n');
        const [type, id, code] = pending.slice(0, end).split('\t');

        pending = pending.slice(end + 1);

        if (type === 'hint' && id === 'select-server') {
          selectServer = true;
        }

        const step = steps.find((item) => item.id === id);

        if (step && type === 'start') {
          step.startedAt = Date.now();
          step.status = 'running';
        } else if (step && type === 'end' && /^\d+$/.test(code ?? '')) {
          step.code = Number(code);
          step.elapsedMs = Math.max(1, Date.now() - (step.startedAt ?? started));
          step.status = step.code === 0 ? 'done' : 'failed';
        } else {
          continue;
        }

        if (!animated) {
          render();
        }
      }

      pending = pending.slice(-1024);
    }
  }

  const closed = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      failure = error.message;
    });
    child.once('close', (code, signal) => {
      childCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
      completed = true;
      resolve();
    });
  });
  const streams = Promise.all([
    capture(child.stdout!), capture(child.stderr!), events(child.stdio[3] as Readable),
  ]).catch((error: Error) => {
    failure = error.message;
    cancellation ??= cancel(1);
  });
  const timer = animated ? setInterval(() => render(), 100) : undefined;

  render();

  try {
    await closed;
    await cancellation;
    await streams;

    if (interrupted) {
      await log.write(`${t('interrupted')}\n`);
    }
  } finally {
    clearInterval(timer);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);

    if (!completed && child.pid) {
      known = await collectBuildProcesses(child.pid, known);
      await signalBuildProcesses(known, 'SIGKILL');
    }

    await log.close();
  }

  const result = interrupted || (failure ? 1 : childCode);
  const elapsed = Date.now() - started;

  if (result !== 0) {
    const step = steps.find((item) => item.status === 'failed' || item.status === 'running');
    const title = step ? t(`steps.${step.id}`) : t('preparing');

    showScreen(session, {
      title: `${t('build')}: ${t(variant === 'server' ? 'serverOnly' : variant)}`,
      state: { text: `✗ ${t('failed', { step: title, code: result })}`, tone: 'error' },
      lines: [
        ...tail,
        ...failure ? [failure] : [],
        '',
        { text: t('log', { path: log.path }), tone: 'muted' },
      ],
      full: true,
    });

    return result;
  }

  render(true);

  const warnings: ScreenLine[] = [];

  try {
    await saveBuildTimings({
      ...historyInput,
      steps: steps.map((step) => ({ id: step.id, durationMs: Math.max(1, step.elapsedMs) })),
      outcome: 'success',
    });
  } catch (error) {
    warnings.push({ text: t('historyError', { reason: (error as Error).message }), tone: 'warning' });
  }

  const summary = variant === 'bundle' ? 'summaryBundle'
    : `summary${variant[0]!.toUpperCase()}${variant.slice(1)}`;
  const target = variant === 'server' ? 'bin/grigdesk-server'
    : variant === 'window' ? 'bin/grigdesk-app' : 'web/dist';
  const lines = [t(summary, { path: path.join(root, target) }), t('total', { time: duration(elapsed) })];

  if (selectServer) {
    lines.push(t('selectServer', { path: path.join(root, 'bin/grigdesk-server') }));
  }

  if (variant !== 'bundle') {
    lines.push(t(variant === 'web' ? 'webHint' : 'reopen'));
  }

  showScreen(session, {
    title: `${t('build')}: ${t(variant === 'server' ? 'serverOnly' : variant)}`,
    state: { text: t('screens.done'), tone: 'success' },
    lines: [
      { text: '█'.repeat(30) + ' 100%', tone: 'success' },
      '',
      ...lines,
      '',
      { text: t('log', { path: log.path }), tone: 'muted' },
      ...warnings,
    ],
    footer: returnToMenu ? t('continue') : undefined,
    full: true,
  });

  return 0;
}

/**
 * Меню передаёт свою сессию, явный build создаёт временную без ожидания клавиши.
 * Cooked-режим направляет настоящий Ctrl+C контроллеру, после выхода всё восстанавливается.
 */
export async function runBuildProgress(
  root: string, variant: string, parent?: TerminalSession,
): Promise<number> {
  const session = parent ?? new TerminalSession();
  const action = async (): Promise<number> => {
    session.suspend();

    try {
      return await observeBuild(root, variant, session, Boolean(parent));
    } finally {
      session.resume();
    }
  };

  return parent ? action() : session.run(action);
}
