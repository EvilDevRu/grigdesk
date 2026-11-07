import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

import { readInstallation, readInstalledPointer } from '../shared/node/installedLayout.ts';
import { InstalledUpdateService } from '../shared/node/installedUpdateService.ts';
import { inspectInstalledServer, startInstalledServer, stopInstalledServer }
  from '../shared/node/installedServer.ts';
import { installedServerUnit, INSTALLED_SERVER_UNIT } from '../shared/node/installedServer.ts';
import { readInstalledUpdate } from '../shared/node/installedUpdateState.ts';
import { runInstalledUpdateWorker } from '../shared/node/installedUpdateWorker.ts';
import { HELP_TEXT, parseArgs } from './args.ts';
import { runUpdateCommand } from './updates.ts';
import { cliTranslator } from './i18n.ts';
import { TerminalSession, terminalText } from './terminal.ts';

const updateActions = ['check-updates', 'update', 'update-status', 'resume-update', 'update-channel'];

/**
 * Установленный ctl не загружает Fastify или source runtimePaths ради консольного меню.
 * Первый кадр использует только receipt/journal; сеть обновляет уже открытый экран в фоне.
 */
async function runInstalledMenu(root: string): Promise<number> {
  const receipt = await readInstallation(root);
  const service = new InstalledUpdateService(root);
  const session = new TerminalSession();
  const { t } = cliTranslator();
  const items = ['check-updates', 'update', 'update-status', 'resume-update',
    'channel-release', 'channel-dev', 'start', 'stop', 'restart', 'exit'];
  let selected = 0;
  let status = await service.status();
  let closed = false;
  let result = '';

  return session.run(async () => {
    /**
     * Текущий канал и новый номер видны вместе с локальной версией даже при ошибке сайта.
     * Внешние данные очищаются общим рендером перед выводом в терминал.
     */
    const render = () => {
      const width = Math.max(1, Math.min(80, session.columns - 1));

      session.draw([
        `GrigDesk ${status.installed.server ?? status.installed.desktop ?? '—'} · ${receipt.channel}`,
        t(`updates.${status.check.state}`)
          + (status.check.state === 'available' ? `: ${status.check.envelope?.payload.version ?? ''}` : ''),
        ...items.map((item, index) => ({
          spans: [{ text: t(`updates.menu_${item}`) }], selected: index === selected,
        })),
        terminalText(result, width),
      ], render, { theme: 'dark', width });
    };

    render();
    void service.checkUpdates().then(async () => {
      status = await service.status();

      if (!closed) {
        render();
      }
    }).catch(() => {});

    try {
      while (true) {
        const key = await session.nextKey();

        if (['escape', 'eof', 'interrupt', 'terminate'].includes(key.name)) {
          return key.name === 'interrupt' ? 130 : 0;
        }

        if (key.name === 'up' || key.name === 'down') {
          selected = (selected + (key.name === 'up' ? -1 : 1) + items.length) % items.length;
        } else if (key.name === 'return') {
          const action = items[selected]!;

          if (action === 'exit') {
            return 0;
          }

          session.suspend();

          try {
            const command = action.startsWith('channel-')
              ? ['server', 'update-channel', action.slice('channel-'.length)] : ['server', action];
            const code = await runInstalledCli(root, command);

            result = t('updates.commandResult', { code });
            status = await service.status();
          } finally {
            session.resume();
          }
        }

        render();
      }
    } finally {
      closed = true;
    }
  });
}

/**
 * Журнал своей службы читается штатным journalctl, manual-запуск — из собственного файла.
 * Подключённый процесс получает терминал напрямую и завершает чтение без shell-подстановок.
 */
async function followInstalledCommand(command: string, args: string[]): Promise<number> {
  const child = spawn(command, args, { stdio: 'inherit', shell: false });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Отдельный ctl управляет только проверенной установкой и известными каноническими launchers.
 * Стоп из app/server cgroup требует явного --force, не обходящего trust или права.
 */
export async function runInstalledCli(root: string, argv: string[]): Promise<number> {
  const { t } = cliTranslator();

  if (!argv.length && process.stdin.isTTY && process.stdout.isTTY) {
    return runInstalledMenu(root);
  }

  let args;

  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'invalid_arguments'}\n`);

    return 2;
  }

  try {
    const receipt = await readInstallation(root);
    const guarded = args.kind === 'open' || args.kind === 'server'
      && (['stop', 'restart'].includes(args.action ?? '') || args.restart || args.rollback);

    if (guarded && !args.force) {
      const cgroup = await fs.readFile('/proc/self/cgroup', 'utf8');

      if (cgroup.split(/[\n/]/u).some((part) => part === 'grigdesk-server.service'
        || /^app-grigdesk-\d+\.scope$/u.test(part))) {
        throw new Error('release_command_inside_owner_use_force');
      }
    }

    if (args.kind === 'help') {
      process.stdout.write(HELP_TEXT);

      return 0;
    }

    if (args.kind === 'version') {
      const pointer = await readInstalledPointer(receipt);

      process.stdout.write(`GrigDesk ${(pointer.desktop ?? pointer.server)?.split('/')[1] ?? ''}\n`);

      return 0;
    }

    if (args.kind === 'server' && updateActions.includes(args.action ?? '')) {
      return runUpdateCommand(args, root, {
        write: (text) => process.stdout.write(text),
        error: (text) => process.stderr.write(text),
      });
    }

    if (args.kind === 'server' && args.action === 'logs') {
      if (await installedServerUnit(receipt)) {
        return followInstalledCommand('journalctl', ['--user', '-u', INSTALLED_SERVER_UNIT,
          '-n', String(args.lines), '--no-pager', ...args.follow ? ['-f'] : []]);
      }

      return followInstalledCommand('tail', ['-n', String(args.lines),
        ...args.follow ? ['-f'] : [], path.join(receipt.root, 'update/server.log')]);
    }

    if (args.kind === 'status' || args.kind === 'server') {
      let state = await inspectInstalledServer(receipt);

      if (args.kind === 'server' && args.action !== 'status') {
        if (args.action === 'stop' || args.action === 'restart') {
          await stopInstalledServer(receipt, state);
        }

        if (args.action === 'start' || args.action === 'restart') {
          await startInstalledServer(receipt);

          if (args.wait) {
            const deadline = Date.now() + 90000;

            while (Date.now() < deadline) {
              if ((await inspectInstalledServer(receipt)).running) {
                break;
              }

              await pause(300);
            }
          }

          const job = await readInstalledUpdate(receipt);

          if (job?.stage === 'applied_not_started' && (await inspectInstalledServer(receipt)).running) {
            await runInstalledUpdateWorker(root, job.id, 'recover');
          }
        }

        state = await inspectInstalledServer(receipt);
      }

      const message = t('updates.serverState', {
        state: state.running ? 'running' : 'stopped', owner: state.kind,
      });

      process.stdout.write(args.json ? JSON.stringify(state) + '\n' : message + '\n');

      return 0;
    }

    if (args.kind === 'open' && receipt.mode !== 'server') {
      const child = spawn(path.join(root, 'update/maintenance'), ['launch', 'desktop'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });

      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();

      return 0;
    }

    throw new Error('maintenance_action_unavailable');
  } catch (error) {
    process.stderr.write(t('updates.failure', {
      code: error instanceof Error ? error.message : 'release_command_failed',
    }) + '\n');

    return 1;
  }
}
