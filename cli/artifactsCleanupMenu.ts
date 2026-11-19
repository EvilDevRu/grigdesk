import type { CleanupApproval } from '../shared/node/artifactsCleanup.ts';
import { parseArgs } from './args.ts';
import {
  artifactsCleanupCommand, artifactsCleanupLines, artifactsCleanupPreview,
} from './artifactsCleanup.ts';
import { cliTranslator } from './i18n.ts';
import { chooseScreenAction, scrollScreen, showScreen } from './screen.ts';
import type { TerminalKey, TerminalSession } from './terminal.ts';

/**
 * Просмотр и удаление используют один экран, включая живую перерисовку в узком терминале.
 * Во время операции футер напоминает о поддерживаемой отмене.
 */
function showCleanupProgress(session: TerminalSession, lines: readonly string[]): void {
  const { t } = cliTranslator();

  showScreen(session, {
    title: t('artifactsCleanup'),
    state: { text: t('screens.running'), tone: 'accent' },
    lines,
    footer: t('screens.cancel'),
    incremental: true,
  });
}

/**
 * Сигналы завершают меню тем же кодом, что обычный процесс CLI.
 * EOF закрывает просмотр без согласия на удаление.
 */
function exitKey(key: TerminalKey): number | undefined {
  return key.name === 'interrupt' ? 130 : key.name === 'terminate' ? 143
    : key.name === 'eof' ? 0 : undefined;
}

/**
 * Предварительный просмотр ничего не меняет, отказ выбран до первого нажатия клавиши.
 * Согласие запускает обычную команду заново; сохранённый список не разрешает обход защит.
 */
async function confirmArtifactsCleanup(
  session: TerminalSession,
): Promise<CleanupApproval | 'cancel' | 'error' | number> {
  const { t } = cliTranslator();
  let lines: string[];
  let approval: CleanupApproval;

  try {
    const result = await artifactsCleanupPreview(session.input,
      (progress) => showCleanupProgress(session, progress));
    const { report, interruptedCode } = result;

    if (interruptedCode !== undefined) {
      return interruptedCode;
    }

    const rootError = report.entries.some((entry) => entry.path === '' && entry.status === 'error');
    const candidates = report.entries.filter((entry) => entry.status === 'would-delete');

    lines = artifactsCleanupLines(report);
    approval = {
      root: report.root,
      paths: new Set(candidates.map((entry) => entry.path)),
    };

    if (rootError || report.errorCount && !approval.paths.size) {
      showScreen(session, {
        title: t('artifactsCleanup'),
        state: { text: t('screens.failed', { code: 1 }), tone: 'error' },
        lines,
        footer: t('screens.resultNavigation'),
      });

      return 'error';
    }
  } catch (error) {
    showScreen(session, {
      title: t('artifactsCleanup'),
      state: { text: t('screens.failed', { code: 1 }), tone: 'error' },
      lines: [String(error)],
      footer: t('screens.resultNavigation'),
    });

    return 'error';
  }

  const choice = await chooseScreenAction(session, {
    title: t('artifactsCleanup'),
    state: { text: t('cleanup.question'), tone: 'warning' },
    lines,
    footer: t('cleanup.navigation'),
  }, {
    accept: t('cleanup.delete'),
    cancel: t('cleanup.cancel'),
  });

  return choice === 'accept' ? approval : choice;
}

/**
 * Установленный ctl использует тот же preview и ту же команду без source-диспетчера сервера.
 * Отмена не запускает удаление, итог остаётся доступным до подтверждения или выхода.
 */
export async function runArtifactsCleanupMenu(
  session: TerminalSession,
): Promise<{ code: number; exit: boolean } | undefined> {
  const confirmation = await confirmArtifactsCleanup(session);

  if (confirmation === 'cancel') {
    return undefined;
  }

  if (typeof confirmation === 'number') {
    return { code: confirmation, exit: true };
  }

  const { t } = cliTranslator();
  const lines: string[] = [];
  let code = 1;

  if (confirmation !== 'error') {
    session.suspend();

    try {
      code = await artifactsCleanupCommand(parseArgs(['artifacts-cleanup']), {
        write: (text) => lines.push(...text.trimEnd().split('\n')),
      }, {
        approval: confirmation,
        renderProgress: (progress) => showCleanupProgress(session, progress),
      });
    } catch (error) {
      lines.push(String(error));
    } finally {
      session.resume();
    }

    showScreen(session, {
      title: t('artifactsCleanup'),
      state: {
        text: t(code === 0 ? 'screens.done' : 'screens.failed', { code }),
        tone: code === 0 ? 'success' : 'error',
      },
      lines,
      footer: t('screens.resultNavigation'),
    });

    if (code === 130 || code === 143) {
      return { code, exit: true };
    }
  }

  for (;;) {
    const key = await session.nextKey();
    const exit = exitKey(key);

    if (exit !== undefined) {
      return { code: exit || code, exit: true };
    }

    if (key.name === 'escape' || key.name === 'return') {
      return { code, exit: false };
    }

    scrollScreen(session, key);
  }
}
