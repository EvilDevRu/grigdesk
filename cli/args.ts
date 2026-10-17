export type Action = 'start' | 'stop' | 'restart' | 'status' | 'logs';

export type CliArgs = {
  kind: 'open' | 'status' | 'server' | 'relay' | 'help' | 'version';
  action?: Action;
  force: boolean;
  wait: boolean;
  json: boolean;
  lines: number;
  follow: boolean;
};

export const HELP_TEXT = `Кокпит — окно и управление локальными компонентами

cockpit                         Открыть окно Кокпита; сервер поднимает само окно
                                (без runtime.json — через службу)
cockpit open [--force]
cockpit status [--json]
cockpit server start [--wait]
cockpit server stop [--force]
cockpit server restart [--wait] [--force]
cockpit server status [--json]
cockpit server logs [-n N|--lines N] [-f|--follow]
cockpit relay start | stop | restart
cockpit relay status [--json]
cockpit relay logs [-n N|--lines N] [-f|--follow]
cockpit desktop … | b24 … | mobile … | release …
cockpit dev | build | deps | run
cockpit --help | -h | help | <группа> --help
cockpit --version

--force разрешает открытие окна, stop и restart из хода агента.
Число строк журнала: 1–10000, по умолчанию 100.
`;

const HELP_HINT = 'Справка: cockpit --help';

/**
 * Разбирает только объявленные формы без внешних вызовов и чтения окружения.
 * Любой чужой флаг или лишний аргумент завершается русской ошибкой до эффектов.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    kind: 'open',
    force: false,
    wait: false,
    json: false,
    lines: 100,
    follow: false,
  };
  const command = argv[0] ?? 'open';

  // Справку просят и после подкоманды: --help или -h в любом месте важнее остальных аргументов.
  if (command === 'help' || argv.some((arg) => arg === '--help' || arg === '-h')) {
    return {
      ...args,
      kind: 'help',
    };
  }

  if (command === '--version' && argv.length === 1) {
    return {
      ...args,
      kind: 'version',
    };
  }

  if (!['open', 'status', 'server', 'relay'].includes(command)) {
    throw new Error(`Неизвестная команда: ${command}. ${HELP_HINT}`);
  }

  args.kind = command as CliArgs['kind'];

  let index = argv.length === 0 ? 0 : 1;

  if (command === 'server' || command === 'relay') {
    const action = argv[index++];

    if (!action) {
      throw new Error(`Не указано действие: cockpit ${command} start | stop | restart | status | logs`);
    }

    if (!['start', 'stop', 'restart', 'status', 'logs'].includes(action)) {
      throw new Error(`Неизвестная команда: ${command} ${action}. ${HELP_HINT}`);
    }

    args.action = action as Action;
  }

  const status = command === 'status' || args.action === 'status';
  const logs = args.action === 'logs';
  const server = command === 'server';
  const allowForce = command === 'open' || (server && ['stop', 'restart'].includes(args.action ?? ''));
  const allowWait = server && ['start', 'restart'].includes(args.action ?? '');

  for (; index < argv.length; index++) {
    const flag = argv[index]!;

    if (flag === '--json' && status) {
      args.json = true;
    } else if (flag === '--force' && allowForce) {
      args.force = true;
    } else if (flag === '--wait' && allowWait) {
      args.wait = true;
    } else if (['-f', '--follow'].includes(flag) && logs) {
      args.follow = true;
    } else if (['-n', '--lines'].includes(flag) && logs) {
      const value = argv[++index] ?? '';
      const lines = Number(value);

      if (!/^\d+$/.test(value) || lines < 1 || lines > 10000) {
        throw new Error('Число строк должно быть целым от 1 до 10000');
      }

      args.lines = lines;
    } else if (flag.startsWith('-')) {
      throw new Error(`Неизвестный флаг: ${flag}. ${HELP_HINT}`);
    } else {
      throw new Error(`Неизвестная команда: лишний аргумент ${flag}. ${HELP_HINT}`);
    }
  }

  return args;
}
