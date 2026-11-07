export type Command =
  | { kind: 'run' }
  | { kind: 'worker' }
  | { kind: 'health' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'license' }
  | {
    kind: 'error';
    message: string;
  };

export const HELP_TEXT = `grigdesk-relay — посредник между телефоном и GrigDesk.

Использование:
  grigdesk-relay                 запустить посредник; настройки — переменные RELAY_*
  grigdesk-relay --healthcheck   проверить посредник на 127.0.0.1, порт RELAY_PORT (по умолчанию 7443)
  grigdesk-relay --version       показать версию
  grigdesk-relay --license       показать лицензию встроенного Node.js
  grigdesk-relay --help          показать эту справку
`;

/**
 * Разбирает только публичные команды и внутренний режим рабочей части.
 * Недоверенные аргументы никогда не возвращаются в сообщении об ошибке.
 */
export function parseCommand(args: readonly string[]): Command {
  if (args.length === 0) {
    return { kind: 'run' };
  }

  const kinds = new Map<string, Exclude<Command['kind'], 'error' | 'run'>>([
    ['--worker', 'worker'],
    ['--healthcheck', 'health'],
    ['--help', 'help'],
    ['-h', 'help'],
    ['--version', 'version'],
    ['--license', 'license'],
  ]);
  const kind = args.length === 1 ? kinds.get(args[0]!) : undefined;

  if (kind) {
    return { kind };
  }

  return {
    kind: 'error',
    message: 'Неизвестная команда. Справка: grigdesk-relay --help',
  };
}

/**
 * Собирает проверяемую строку версии без чтения настроек и открытия сети.
 * Версия Node берётся у исполняющего процесса, версия приложения — при сборке.
 */
export function versionLine(app: string, node: string, platform: string, arch: string): string {
  return `grigdesk-relay ${app} (Node ${node}, ${platform} ${arch})`;
}
