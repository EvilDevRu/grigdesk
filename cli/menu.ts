import { existsSync } from 'node:fs';
import path from 'node:path';

import { runtimeRoot } from '../server/src/lib/runtimePaths.ts';
import { isPortableBundle } from '../shared/node/bundleLayout.ts';
import { readCliContext, runCli } from './commands.ts';
import { runBuildProgress } from './buildProgress.ts';
import { cliTranslator } from './i18n.ts';
import { sourceInstallation } from './interactive.ts';
import { readServer } from './server.ts';
import { readText, runAttached } from './system.ts';
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

const logo = [
  '█████ ████  █ █████ ████  █████ █████ █   █',
  '█     █   █ █ █     █   █ █     █     █  █',
  '█ ███ ████  █ █ ███ █   █ ████  █████ ███',
  '█   █ █  █  █ █   █ █   █ █         █ █  █',
  '█████ █   █ █ █████ ████  █████ █████ █   █',
];

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
  const build = ['all', 'server', 'web', 'window', 'bundle'].map((variant) => ({
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
    { label: 'exit', description: 'exitDescription' },
  ];
}

/**
 * Обычное действие выполняется тем же dispatcher после восстановления cooked-ввода.
 * Открытие и долгие команды завершают CLI, короткие действия возвращают результат в меню.
 */
export async function runMenuAction(root: string, argv: string[], session: TerminalSession) {
  session.suspend();

  try {
    return ['dev', 'deps', 'run'].includes(argv[0] ?? '')
      ? await runAttached('/bin/bash', [path.join(root, 'bin/grigdesk-ctl'), ...argv])
      : await runCli(argv);
  } finally {
    session.resume();
  }
}

/**
 * Имя собирается по Unicode-символам, поэтому backspace не разрывает кириллицу.
 * Esc возвращает отмену и не вызывает команду с частичным значением.
 */
async function promptText(session: TerminalSession, prompt: string): Promise<string | number | null> {
  let value = '';
  const render = () => session.draw([prompt, value], render);

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
  const header = [version?.trim() ?? '', t(kind), t('serverState', { state: t(`states.${server.state}`) }),
    t('windowState', { state: t(`states.${window}`) })].join(' · ');

  return session.run(async () => {
    /**
     * Каждый уровень рисуется целиком с текущей шириной и сохранённым выбором.
     * Описания в узком окне занимают отдельную строку вместо сдвига соседних пунктов.
     */
    const render = (): void => {
      const level = levels.at(-1)!;
      const lines = session.columns >= 65 ? [...logo, header] : [`GrigDesk ${version?.trim() ?? ''}`];

      lines.push('', `◆ ${t(level.title)}`);

      for (const [index, item] of level.items.entries()) {
        const marker = index === level.selected ? '●' : '○';
        const title = `│ ${marker} ${t(item.label)}${item.children ? ' ›' : ''}`;

        if (session.columns >= 80) {
          lines.push(`${title.padEnd(30)} ${t(item.description)}`);
        } else {
          lines.push(title, `│   ${t(item.description)}`);
        }
      }

      lines.push(`└ ${t('navigation')}`);
      session.draw(lines, render);
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
          return 0;
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
          return 0;
        } else {
          const argv = [...item.argv ?? []];

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

          const code = item.variant ? await runBuildProgress(root, item.variant, session)
            : await runMenuAction(root, argv, session);

          if (item.label === 'open' || ['dev', 'run'].includes(item.label) || item.variant && code !== 0) {
            return code;
          }

          session.output.write(t('continue') + '\n');

          while (true) {
            const result = await session.nextKey();
            const resultExit = exitKey(result);

            if (resultExit !== undefined) {
              return resultExit;
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
