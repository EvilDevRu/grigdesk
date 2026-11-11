import { existsSync } from 'node:fs';
import path from 'node:path';

import { runtimeRoot } from '../server/src/lib/runtimePaths.ts';
import { isPortableBundle } from '../shared/node/bundleLayout.ts';
import { readCliContext } from './commands.ts';
import { confirmArtifactsCleanup } from './artifactsCleanupMenu.ts';
import { runBuildProgress } from './buildProgress.ts';
import { cliTranslator } from './i18n.ts';
import { sourceInstallation } from './interactive.ts';
import { menuLines } from './menuView.ts';
import { runPresentedCommand } from './presentation.ts';
import { scrollScreen, showScreen } from './screen.ts';
import { readServer } from './server.ts';
import { readText } from './system.ts';
import { TerminalSession } from './terminal.ts';
import type { TerminalKey } from './terminal.ts';
import { readWindow } from './window.ts';

interface MenuItem {
  label: string;
  description: string;
  argv?: string[];
  children?: MenuItem[];
  prompt?: string;
  variant?: string;
}

/**
 * Сигналы и закрытие ввода завершают любой уровень с привычным кодом процесса.
 * Обычные клавиши остаются действиями текущего меню или текстового поля.
 */
function exitKey(key: TerminalKey): number | undefined {
  return key.name === 'interrupt' ? 130 : key.name === 'terminate' ? 143
    : key.name === 'eof' ? 0 : undefined;
}

/**
 * Дерево описывает только существующие команды и порядок, принятый в задании.
 * Никаких force/follow и скрытых служебных действий пункты не добавляют.
 */
function menuItems(source: boolean): MenuItem[] {
  const service = (component: string): MenuItem[] => ['start', 'stop', 'restart', 'logs'].map((name) => ({
    label: name,
    description: `${name}Description`,
    argv: [component, name],
  }));
  const build = ['all', 'server', 'web', 'window', 'deepseek', 'apk'].map((variant) => ({
    label: variant === 'server' ? 'serverOnly' : variant,
    description: `${variant === 'server' ? 'serverOnly' : variant}Description`,
    variant,
  }));

  return [
    {
      label: 'open',
      description: 'openDescription',
      argv: ['open'],
    },
    {
      label: 'status',
      description: 'statusDescription',
      argv: ['status'],
    },
    {
      label: 'server',
      description: 'serviceDescription',
      children: service('server'),
    },
    {
      label: 'relay',
      description: 'serviceDescription',
      children: service('relay'),
    },
    {
      label: 'devices',
      description: 'devicesDescription',
      children: ['add', 'list', 'revoke'].map((name) => ({
        label: name,
        description: `${name}Description`,
        argv: ['device', name],
        prompt: name === 'add' ? 'namePrompt' : name === 'revoke' ? 'idPrompt' : undefined,
      })),
    },
    ...source ? [
      {
      label: 'build',
      description: 'buildDescription',
      children: build,
    },
      {
        label: 'development',
        description: 'developmentDescription',
        children: ['dev', 'deps', 'run'].map((name) => ({
          label: name,
          description: `${name}Description`,
          argv: [name],
        })),
      },
    ] : [],
    {
      label: 'artifactsCleanup',
      description: 'artifactsCleanupDescription',
      argv: ['artifacts-cleanup'],
    },
    { label: 'exit', description: 'exitDescription' },
  ];
}

/**
 * Действие получает тот же диспетчер и проверки допуска через общий экран результата.
 * Прямой вывод, журналы и ошибки отображаются в той же палитре, что и меню.
 */
export async function runMenuAction(root: string, argv: string[], session: TerminalSession) {
  return runPresentedCommand(root, argv, session);
}

/**
 * Имя собирается по Unicode-символам, поэтому backspace не разрывает кириллицу.
 * Esc возвращает отмену и не вызывает команду с частичным значением.
 */
async function promptText(session: TerminalSession, prompt: string): Promise<string | number | null> {
  const { t } = cliTranslator();
  let value = '';
  const render = () => showScreen(session, {
    title: prompt,
    lines: (width) => [{
      text: '› ' + [...value].slice(-Math.max(1, width - 3)).join('') + '▏',
      selected: true,
    }],
    footer: t('screens.inputNavigation'),
  });

  render();

  while (true) {
    const key = await session.nextKey();
    const exit = exitKey(key);

    if (exit !== undefined) {
      return exit;
    }

    if (key.name === 'escape') {
      return null;
    }

    if (key.name === 'return' && value.trim()) {
      return value.trim();
    }

    if (key.name === 'backspace') {
      value = [...value].slice(0, -1).join('');
    } else if (key.text && !/[\x00-\x1f\x7f]/.test(key.text)) {
      value += key.text;
    }

    render();
  }
}

/**
 * Шапка ограничивает обе внешние пробы коротким сроком и не опрашивает Docker.
 * Каждый уровень хранит свой выбор, результат команды остаётся виден до Enter или Esc.
 */
export async function runMenu(root: string): Promise<number> {
  const session = new TerminalSession();
  const { t } = cliTranslator();
  const { settings } = await readCliContext(root);
  const [version, server, window] = await Promise.all([
    readText(path.join(runtimeRoot(), 'VERSION')),
    readServer(root, settings, { timeoutMs: 700, includeJournal: false }),
    readWindow(root, process.env),
  ]);
  const source = sourceInstallation(root);
  const kind = isPortableBundle(root) ? 'portable' : existsSync(path.join(root, 'release.json'))
    ? 'release' : source ? 'source' : 'installed';
  const levels = [{
    title: 'question',
    items: menuItems(source),
    selected: 0,
  }];
  let cleanupFailure = 0;

  return session.run(async () => {
    /**
     * Представление получает только состояния и дерево существующих команд.
     * Структурированные стили добавляются после очистки текста в общей терминальной сессии.
     */
    const render = (): void => {
      const width = Math.max(1, Math.min(80, session.columns - 1));
      const lines = menuLines({
        width,
        rows: session.rows,
        version: version?.trim() ?? '',
        installation: kind,
        server: server.state,
        window,
        levels,
        t,
      });

      session.draw(lines, render, { theme: 'dark', width });
    };

    render();

    while (levels.length) {
      const level = levels.at(-1)!;
      const key = await session.nextKey();
      const exit = exitKey(key);

      if (exit !== undefined) {
        return exit;
      }

      if (key.name === 'escape') {
        levels.pop();

        if (!levels.length) {
          return cleanupFailure;
        }
      } else if (key.name === 'down' || key.name === 'up') {
        const direction = key.name === 'down' ? 1 : -1;

        level.selected = (level.selected + direction + level.items.length) % level.items.length;
      } else if (key.name === 'return') {
        const item = level.items[level.selected]!;

        if (item.children) {
          levels.push({
            title: item.label,
            items: item.children,
            selected: 0,
          });
        } else if (item.label === 'exit') {
          return cleanupFailure;
        } else {
          const argv = [...item.argv ?? []];
          const confirmation = item.label === 'artifactsCleanup'
            ? await confirmArtifactsCleanup(session) : 'confirm';

          if (typeof confirmation === 'number') {
            return confirmation;
          }

          if (confirmation === 'cancel') {
            render();

            continue;
          }

          if (item.prompt) {
            const value = await promptText(session, t(item.prompt));

            if (typeof value === 'number') {
              return value;
            }

            if (value === null) {
              render();

              continue;
            }

            argv.push(value);
          }

          const code = confirmation === 'error' ? 1
            : item.variant ? await runBuildProgress(root, item.variant, session)
            : await runMenuAction(root, argv, session);

          if (item.label === 'artifactsCleanup' && code !== 0) {
            cleanupFailure = code;
          }

          if (item.label === 'open' || ['dev', 'run'].includes(item.label) || item.variant && code !== 0) {
            return code;
          }

          if (item.variant) {
            render();

            continue;
          }

          while (true) {
            const result = await session.nextKey();
            const resultExit = exitKey(result);

            if (resultExit !== undefined) {
              return resultExit;
            }

            if (scrollScreen(session, result)) {
              continue;
            }

            if (['return', 'escape'].includes(result.name)) {
              break;
            }
          }
        }
      }

      render();
    }

    return 0;
  });
}
