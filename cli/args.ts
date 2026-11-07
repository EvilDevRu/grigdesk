export type Action = 'start' | 'stop' | 'restart' | 'status' | 'logs'
  | 'check-updates' | 'update' | 'update-status' | 'resume-update' | 'update-channel';

export type CliArgs = {
  kind: 'open' | 'status' | 'server' | 'relay' | 'device' | 'help' | 'version';
  deviceAction?: 'add' | 'list' | 'revoke';
  deviceValue?: string;
  address?: string;
  action?: Action;
  restart?: boolean;
  rollback?: boolean;
  channel?: 'release' | 'dev';
  force: boolean;
  wait: boolean;
  json: boolean;
  lines: number;
  follow: boolean;
};

export const HELP_TEXT = `GrigDesk — окно и управление локальными компонентами

grigdesk-ctl                     Меню в терминале, иначе справка
grigdesk-ctl open [--force]       Открыть окно GrigDesk; сервер поднимает само окно
                                (без runtime.json — через службу)
grigdesk-ctl status [--json]
grigdesk-ctl server start [--wait]
grigdesk-ctl server stop [--force]
grigdesk-ctl server restart [--wait] [--force]
grigdesk-ctl server status [--json]
grigdesk-ctl server logs [-n N|--lines N] [-f|--follow]
grigdesk-ctl server check-updates [--json]
grigdesk-ctl server update [--restart] [--json] [--force]
grigdesk-ctl server update-status [--json]
grigdesk-ctl server resume-update [--restart] [--json] [--force]
                                [--rollback — вернуть прежний выпуск]
grigdesk-ctl server update-channel release|dev
grigdesk-ctl relay start | stop | restart
grigdesk-ctl relay status [--json]
grigdesk-ctl relay logs [-n N|--lines N] [-f|--follow]
grigdesk-ctl device add <имя> [--address host:port] [--json]
grigdesk-ctl device list [--json]
grigdesk-ctl device revoke <id>
grigdesk-ctl desktop … | tracker … | mobile … | release …
grigdesk-ctl desktop use-server <ELF|R>  Выбрать серверный ELF или прежний SEA-комплект для окна
grigdesk-ctl build [all|server|web|window|deepseek|apk]
                                Без аргументов: сервер → веб → окно (all по умолчанию)
                                apk: Android-приложение со встроенным вебом
grigdesk-ctl dev | deps | run
grigdesk-ctl --help | -h | help | <группа> --help
grigdesk-ctl --version

--force разрешает открытие окна, stop и restart из хода агента.
Число строк журнала: 1–10000, по умолчанию 100.
`;

const HELP_HINT = 'Справка: grigdesk-ctl --help';

/**
 * Разбирает только объявленные формы без внешних вызовов и чтения окружения.
 * Любой чужой флаг или лишний аргумент завершается русской ошибкой до эффектов.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    kind: 'help',
    force: false,
    wait: false,
    json: false,
    lines: 100,
    follow: false,
  };
  const command = argv[0] ?? 'help';

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

  if (command === 'device') {
    return parseDevice(argv.slice(1), args);
  }

  if (!['open', 'status', 'server', 'relay'].includes(command)) {
    throw new Error(`Неизвестная команда: ${command}. ${HELP_HINT}`);
  }

  args.kind = command as CliArgs['kind'];

  let index = argv.length === 0 ? 0 : 1;

  if (command === 'server' || command === 'relay') {
    const action = argv[index++];

    if (!action) {
      throw new Error(`Не указано действие: grigdesk-ctl ${command} start | stop | restart | status | logs`);
    }

    const updates = ['check-updates', 'update', 'update-status', 'resume-update', 'update-channel'];

    if (!['start', 'stop', 'restart', 'status', 'logs', ...(command === 'server' ? updates : [])]
      .includes(action)) {
      throw new Error(`Неизвестная команда: ${command} ${action}. ${HELP_HINT}`);
    }

    args.action = action as Action;
  }

  if (args.action === 'update-channel') {
    const channel = argv[index++];

    if (channel !== 'release' && channel !== 'dev') {
      throw new Error('Укажите канал release или dev.');
    }

    args.channel = channel;
  }

  const update = args.action === 'update' || args.action === 'resume-update';
  const status = command === 'status'
    || ['status', 'check-updates', 'update-status', 'update', 'resume-update'].includes(args.action ?? '');
  const logs = args.action === 'logs';
  const server = command === 'server';
  const allowForce = command === 'open'
    || (server && ['stop', 'restart', 'update', 'resume-update'].includes(args.action ?? ''));
  const allowWait = server && ['start', 'restart'].includes(args.action ?? '');
  const allowRollback = args.action === 'resume-update';

  for (; index < argv.length; index++) {
    const flag = argv[index]!;

    if (flag === '--json' && status) {
      args.json = true;
    } else if (flag === '--restart' && update) {
      args.restart = true;
    } else if (flag === '--rollback' && allowRollback) {
      args.rollback = true;
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

/**
 * Устройства имеют собственные формы аргументов, независимые от управления службами.
 * Ошибки разбора возникают до чтения ключа и любых запросов к серверу.
 */
function parseDevice(argv: readonly string[], defaults: CliArgs): CliArgs {
  const [action, ...tail] = argv;

  if (!['add', 'list', 'revoke'].includes(action ?? '')) {
    throw new Error('Укажите grigdesk-ctl device add <имя> | list | revoke <id>.');
  }

  const args: CliArgs = {
    ...defaults,
    kind: 'device',
    deviceAction: action as CliArgs['deviceAction'],
  };

  if (action !== 'list') {
    const value = tail.shift();

    if (!value?.trim() || value.startsWith('-')) {
      throw new Error('Укажите имя или id: grigdesk-ctl device --help.');
    }

    args.deviceValue = value;
  }

  while (tail.length) {
    const flag = tail.shift();

    if (flag === '--json' && action !== 'revoke') {
      args.json = true;
    } else if (flag === '--address' && action === 'add' && !args.address) {
      const address = tail.shift();

      if (!address || address.startsWith('-')) {
        throw new Error('Укажите host:port после --address. Справка: grigdesk-ctl device --help.');
      }

      args.address = address;
    } else {
      throw new Error('Неизвестный аргумент устройства. Справка: grigdesk-ctl device --help.');
    }
  }

  return args;
}
