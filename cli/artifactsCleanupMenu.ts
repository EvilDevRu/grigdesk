import { parseArgs } from './args.ts';
import {
  artifactsCleanupCommand, artifactsCleanupLines, artifactsCleanupPreview,
} from './artifactsCleanup.ts';
import { cliTranslator } from './i18n.ts';
import { scrollScreen, showScreen } from './screen.ts';
import type { TerminalKey, TerminalSession } from './terminal.ts';

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
export async function confirmArtifactsCleanup(
  session: TerminalSession,
): Promise<'confirm' | 'cancel' | 'error' | number> {
  const { t } = cliTranslator();
  let lines: string[];

  try {
    const { report, interruptedCode } = await artifactsCleanupPreview(session.input);

    if (interruptedCode !== undefined) {
      return interruptedCode;
    }

    lines = artifactsCleanupLines(report);

    if (report.errorCount) {
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

  let remove = false;
  const render = () => showScreen(session, {
    title: t('artifactsCleanup'),
    state: { text: t('cleanup.question'), tone: 'warning' },
    lines,
    footer: [
      `${remove ? ' ' : '›'} ${t('cleanup.cancel')}`,
      `${remove ? '›' : ' '} ${t('cleanup.delete')}`,
      t('cleanup.navigation'),
    ].join(' · '),
  });

  render();

  for (;;) {
    const key = await session.nextKey();
    const exit = exitKey(key);

    if (exit !== undefined) {
      return exit;
    }

    if (key.name === 'escape') {
      return 'cancel';
    }

    if (key.name === 'return') {
      return remove ? 'confirm' : 'cancel';
    }

    if (['up', 'down', 'left', 'right'].includes(key.name)) {
      remove = !remove;
      render();
    } else {
      scrollScreen(session, key);
    }
  }
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

  if (confirmation === 'confirm') {
    session.suspend();
    showScreen(session, {
      title: t('artifactsCleanup'),
      state: { text: t('screens.running'), tone: 'accent' },
      lines: [],
      footer: t('screens.cancel'),
    });

    try {
      code = await artifactsCleanupCommand(parseArgs(['artifacts-cleanup']), {
        write: (text) => lines.push(...text.trimEnd().split('\n')),
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
