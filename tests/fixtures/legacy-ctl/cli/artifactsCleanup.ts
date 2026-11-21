import os from 'node:os';

import { cleanupArtifacts } from '../../../../shared/node/artifactsCleanup.ts';
import type { CleanupApproval, CleanupProgress, CleanupReport }
  from '../../../../shared/node/artifactsCleanup.ts';
import { artifactsPath } from '../../../../shared/runtime/dataHome.ts';
import type { CliArgs } from './args.ts';
import { buildProgressBar } from '../../../../cli/buildState.ts';
import { cliTranslator } from '../../../../cli/i18n.ts';
import type { CliOutput } from './output.ts';
import { terminalText } from '../../../../cli/terminal.ts';

interface CleanupRunResult {
  report: CleanupReport;
  interruptedCode: number | undefined;
}

interface CleanupKey {
  name?: string;
  ctrl?: boolean;
}

type RenderProgress = (lines: readonly string[]) => void;

interface CleanupCommandOptions {
  renderProgress?: RenderProgress;
  approval?: CleanupApproval;
}

/**
 * Время обновляется и во время одной долгой операции с диском.
 * Шкала использует число позиций, а счётчик записей показывает работу внутри большой папки.
 */
async function withCleanupProgress(
  action: (publish?: (progress: CleanupProgress) => void) => Promise<CleanupReport>,
  render?: RenderProgress,
): Promise<CleanupReport> {
  if (!render) {
    return action();
  }

  const { t } = cliTranslator();
  const start = performance.now();
  let progress: CleanupProgress = {
    phase: 'scan',
    path: '',
    completed: 0,
    total: 0,
    visited: 0,
    freedBytes: 0,
  };

  /**
   * Путь выводится отдельной строкой, чтобы счётчики оставались видны в узком терминале.
   * Для пустого или ещё неизвестного списка проценты не вычисляются.
   */
  const draw = () => {
    const { phase, path, completed, total, visited, freedBytes } = progress;
    const seconds = Math.floor((performance.now() - start) / 1000);
    const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const count = total ? t('cleanup.progress.count', { completed, total }) : '';
    const bar = total ? buildProgressBar(completed / total * 100, 12) : '';

    render([
      `${t(`cleanup.progress.${phase}`)} · ${time}`,
      ...total ? [`${count} · ${bar}`] : [],
      t('cleanup.progress.visited', { count: visited }),
      ...freedBytes ? [t('cleanup.freedTotal', { bytes: freedBytes })] : [],
      ...path ? [terminalText(path, Number.MAX_SAFE_INTEGER)] : [],
    ]);
  };

  const timer = setInterval(draw, process.env.TERM === 'dumb' ? 1000 : 350);

  try {
    draw();

    return await action((update) => {
      progress = update;
    });
  } finally {
    clearInterval(timer);
  }
}

/**
 * Отмена сообщает движку причину и ждёт освобождения его собственных lock-ов.
 * Обработчики принадлежат только одной уборке и снимаются также при ошибке чтения.
 */
async function interruptibleCleanup(
  action: (signal: AbortSignal) => Promise<CleanupReport>,
  input?: NodeJS.ReadStream,
): Promise<CleanupRunResult> {
  const controller = new AbortController();
  let interruptedCode: number | undefined;
  const abort = (code: number) => {
    if (!controller.signal.aborted) {
      interruptedCode = code;
      controller.abort(code);
    }
  };
  const interrupt = () => abort(130);
  const terminate = () => abort(143);
  const end = () => abort(0);
  const keypress = (_text: string, key: CleanupKey) => {
    if (key.ctrl && key.name === 'c') {
      interrupt();
    }
  };

  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  input?.on('keypress', keypress);
  input?.on('end', end);

  try {
    const report = await action(controller.signal);

    if (controller.signal.aborted) {
      report.interrupted = true;
    }

    return { report, interruptedCode };
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    input?.removeListener('keypress', keypress);
    input?.removeListener('end', end);
  }
}

/**
 * Команда работает с локальной папкой выбранного окружения без чтения настроек сервера.
 * Тот же предварительный просмотр используется меню перед согласием владельца.
 */
export async function artifactsCleanupPreview(
  input: NodeJS.ReadStream, render: RenderProgress,
): Promise<CleanupRunResult> {
  return interruptibleCleanup((signal) => withCleanupProgress((onProgress) => cleanupArtifacts({
    root: artifactsPath({ env: process.env, home: process.env.HOME || os.homedir() }),
    scope: 'artifacts',
    dryRun: true,
    signal,
    onProgress,
  }), render), input);
}

/**
 * Машинные причины переводятся только на границе представления, пути остаются данными.
 * Байты показываются явно: итог не обещает точное изменение свободных блоков файловой системы.
 */
export function artifactsCleanupLines(report: CleanupReport): string[] {
  const { t } = cliTranslator();

  return [
    t('cleanup.root', { path: terminalText(report.root, Number.MAX_SAFE_INTEGER) }),
    t('cleanup.policy', { days: report.olderThanMs / 86400000, keep: report.keepGenerations }),
    ...report.entries.map((entry) => t('cleanup.entry', {
      path: terminalText(entry.path, Number.MAX_SAFE_INTEGER),
      bytes: String(entry.bytes ?? '?'),
      status: t(`cleanup.status.${entry.status}`),
      reason: entry.reason ? t(`cleanup.reason.${entry.reason}`) : '',
    })),
    t(report.dryRun ? 'cleanup.previewTotal' : 'cleanup.freedTotal', {
      bytes: String(report.dryRun ? report.wouldDeleteBytes : report.freedBytes),
    }),
    t('cleanup.errors', { count: report.errorCount }),
    ...report.interrupted ? [t('cleanup.interrupted')] : [],
  ];
}

/**
 * JSON остаётся одним документом даже при частичном отказе удаления отдельных деревьев.
 * Нормальные защиты дают успех, а ошибки ввода-вывода возвращают ненулевой код.
 */
export async function artifactsCleanupCommand(
  args: CliArgs, output: Pick<CliOutput, 'write'>, options: CleanupCommandOptions = {},
): Promise<number> {
  const showStderr = !args.json && !options.renderProgress && process.stderr.isTTY;
  const redraw = showStderr && process.env.TERM !== 'dumb';
  let rows = 0;

  /**
   * Стирается только предыдущий блок прогресса в stderr.
   * Итоговый отчёт начинается с освободившейся строки и сохраняется в stdout.
   */
  const clearProgress = () => {
    if (redraw && rows) {
      process.stderr.write('\r\x1b[2K' + '\x1b[1A\r\x1b[2K'.repeat(rows - 1));
    }
  };
  const render = options.renderProgress ?? (showStderr ? (lines: readonly string[]) => {
    if (!redraw) {
      process.stderr.write(lines.join(' · ') + '\n');

      return;
    }

    const width = Math.max(1, (process.stderr.columns || 80) - 1);

    clearProgress();
    process.stderr.write(lines.map((line) => terminalText(line, width)).join('\n'));
    rows = lines.length;
  } : undefined);

  const result = await interruptibleCleanup((signal) => withCleanupProgress(
    (onProgress) => cleanupArtifacts({
      root: artifactsPath({ env: process.env, home: process.env.HOME || os.homedir() }),
      scope: 'artifacts',
      dryRun: args.dryRun,
      olderThanMs: args.olderThanMs,
      keepGenerations: args.keepGenerations,
      approval: options.approval,
      signal,
      onProgress,
    }), render,
  )).finally(clearProgress);
  const { report, interruptedCode } = result;

  output.write(args.json ? JSON.stringify(report) + '\n' : artifactsCleanupLines(report).join('\n') + '\n');

  return interruptedCode ?? (report.errorCount ? 1 : 0);
}
