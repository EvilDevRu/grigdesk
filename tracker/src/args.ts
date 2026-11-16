export type TimerAction = 'start' | 'pause' | 'stop';

export type ApiCommand = (
  | { kind: 'boards' }
  | { kind: 'dashboard' }
  | {
    kind: 'task';
    id: string;
  }
  | {
    kind: 'comment';
    id: string;
    text: string;
  }
  | {
    kind: 'timer';
    id: string;
    action: TimerAction;
  }
  | {
    kind: 'start';
    id: string;
  }
  | {
    kind: 'complete';
    id: string;
  }
  | {
    kind: 'renew';
    id: string;
  }
  | {
    kind: 'analyze';
    id: string;
  }
  | {
    kind: 'launch-options';
    id: string;
  }
  | {
    kind: 'launch';
    id: string;
  }
  | { kind: 'create' }
  | {
    kind: 'users';
    query: string;
  }) & { board?: string };

export type Command = ApiCommand | { kind: 'help' } | { kind: 'version' } | { kind: 'license' };

export const HELP_TEXT = `tracker — команды задач Б24 через локальный GrigDesk.

Использование:
  tracker dashboard                    доска: мои задачи, показатели и графики
  tracker boards                       включённые доски и доска по умолчанию
  tracker --board <id> <команда>        выполнить команду на указанной доске
  tracker task <id>                    детали задачи
  tracker comment <id> <текст…>        комментарий к задаче
  tracker timer <id> start|pause|stop  таймер задачи
  tracker start <id>                   взять в работу: возобновить и запустить таймер
  tracker complete <id>                завершить задачу со стопом таймера
  tracker renew <id>                   возобновить задачу
  tracker analyze <id>                 поставить задачу в очередь оценки
  tracker launch-options <id>          параметры запуска конвейера
  tracker launch <id>                  запустить конвейер с JSON из stdin
  tracker create                       создать задачу из JSON на stdin
  tracker users [запрос]               сотрудники для выбора исполнителя
  tracker --version                    показать версию
  tracker --license                    показать лицензию Node.js
  tracker --help                       показать эту справку

Адрес и токен: GRIGDESK_URL и GRIGDESK_TOKEN либо настройки папки данных GrigDesk.
`;

const LOCAL_FLAGS = new Map<string, 'help' | 'version' | 'license'>([
  ['--help', 'help'],
  ['-h', 'help'],
  ['--version', 'version'],
  ['--license', 'license'],
]);

const TIMER_ACTIONS: readonly TimerAction[] = ['start', 'pause', 'stop'];

/**
 * Ошибка разбора аргументов: app добавляет к ней справку и возвращает код 2.
 * Сообщение никогда не содержит недоверенный текст аргументов.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Требует точное число аргументов после имени команды.
 * Лишние и недостающие значения одинаково считаются ошибкой использования.
 */
function expectCount(command: string, rest: readonly string[], count: number): void {
  if (rest.length > count) {
    throw new UsageError(`Лишние аргументы у команды ${command}.`);
  }

  if (rest.length < count) {
    throw new UsageError(`Не хватает аргументов у команды ${command}.`);
  }
}

/**
 * ID остаётся строкой без числовой нормализации: её выполняет сервер.
 * Пустое значение отвергается до настроек и сети.
 */
function requireId(command: string, value: string | undefined): string {
  if (!value) {
    throw new UsageError(`Не указан ID задачи у команды ${command}.`);
  }

  return value;
}

/**
 * Разбирает команды задач с ID: точное число аргументов и непустой ID.
 * Comment и timer имеют собственные правила хвоста.
 */
function parseTaskCommand(command: string, rest: readonly string[]): ApiCommand {
  if (command === 'comment') {
    if (rest.length < 2) {
      throw new UsageError('Команде comment нужны ID и текст комментария.');
    }

    return {
      kind: 'comment',
      id: requireId(command, rest[0]),
      text: rest.slice(1).join(' '),
    };
  }

  if (command === 'timer') {
    expectCount(command, rest, 2);

    const action = TIMER_ACTIONS.find((item) => item === rest[1]);

    if (!action) {
      throw new UsageError('Действие таймера: start, pause или stop.');
    }

    return {
      kind: 'timer',
      id: requireId(command, rest[0]),
      action,
    };
  }

  expectCount(command, rest, 1);

  const id = requireId(command, rest[0]);

  switch (command) {
    case 'analyze':
    case 'launch-options':
    case 'launch':
      return {
        kind: command,
        id,
      };
    case 'task':
      return {
        kind: 'task',
        id,
      };
    case 'start':
      return {
        kind: 'start',
        id,
      };
    case 'complete':
      return {
        kind: 'complete',
        id,
      };
    default:
      return {
        kind: 'renew',
        id,
      };
  }
}

/**
 * Разбирает argv до чтения настроек, stdin и сети.
 * Локальные флаги допустимы только единственным аргументом; ошибка — UsageError.
 */
export function parseArgs(argv: readonly string[]): Command {
  const args: string[] = [];
  let board: string | undefined;
  let literal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (!literal && value === '--') {
      literal = true;
    } else if (!literal && value === '--board') {
      const target = argv[++index];

      if (board !== undefined || !target?.trim() || target.startsWith('--')) {
        throw new UsageError('Укажите --board один раз с непустым ID доски.');
      }

      board = target;
    } else {
      args.push(value!);
    }
  }

  const command = parseCommand(args);

  if (board === undefined) {
    return command;
  }

  if (['help', 'version', 'license', 'boards'].includes(command.kind)) {
    throw new UsageError('У этой команды нет целевой доски.');
  }

  return { ...command, board } as ApiCommand;
}

/**
 * Разбирает команду после выделения общей цели.
 * Текст после разделителя уже не интерпретируется как флаги.
 */
function parseCommand(argv: readonly string[]): Command {
  const [command, ...rest] = argv;

  if (command === undefined) {
    throw new UsageError('Не указана команда.');
  }

  const local = LOCAL_FLAGS.get(command);

  if (local) {
    expectCount(command, rest, 0);

    return { kind: local };
  }

  switch (command) {
    case 'dashboard':
    case 'boards':
    case 'create':
      expectCount(command, rest, 0);

      return { kind: command };
    case 'users':
      if (rest.length > 1) {
        throw new UsageError('Команда users принимает не больше одного запроса; слова возьмите в кавычки.');
      }

      return {
        kind: 'users',
        query: rest[0] ?? '',
      };
    case 'analyze':
    case 'launch-options':
    case 'launch':
    case 'task':
    case 'comment':
    case 'timer':
    case 'start':
    case 'complete':
    case 'renew':
      return parseTaskCommand(command, rest);
    default:
      throw new UsageError('Неизвестная команда.');
  }
}
