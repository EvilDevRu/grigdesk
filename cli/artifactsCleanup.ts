import os from 'node:os';

import { cleanupArtifacts } from '../shared/node/artifactsCleanup.ts';
import type { CleanupReport } from '../shared/node/artifactsCleanup.ts';
import { artifactsPath } from '../shared/runtime/dataHome.ts';
import type { CliArgs } from './args.ts';
import { cliTranslator } from './i18n.ts';
import type { CliOutput } from './output.ts';
import { terminalText } from './terminal.ts';

interface CleanupRunResult {
  report: CleanupReport;
  interruptedCode: number | undefined;
}

interface CleanupKey {
  name?: string;
  ctrl?: boolean;
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
export async function artifactsCleanupPreview(input: NodeJS.ReadStream): Promise<CleanupRunResult> {
  return interruptibleCleanup((signal) => cleanupArtifacts({
    root: artifactsPath({ env: process.env, home: process.env.HOME || os.homedir() }),
    scope: 'artifacts',
    dryRun: true,
    signal,
  }), input);
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
  args: CliArgs, output: Pick<CliOutput, 'write'>,
): Promise<number> {
  const { report, interruptedCode } = await interruptibleCleanup((signal) => cleanupArtifacts({
    root: artifactsPath({ env: process.env, home: process.env.HOME || os.homedir() }),
    scope: 'artifacts',
    dryRun: args.dryRun,
    olderThanMs: args.olderThanMs,
    keepGenerations: args.keepGenerations,
    signal,
  }));

  output.write(args.json ? JSON.stringify(report) + '\n' : artifactsCleanupLines(report).join('\n') + '\n');

  return interruptedCode ?? (report.errorCount ? 1 : 0);
}
