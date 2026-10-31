/**
 * Аргумент проходит два уровня экранирования Desktop Entry: строку и кавычки Exec.
 * Проценты остаются буквальными; оболочка команд при запуске не используется.
 */
function desktopExec(argument: string): string {
  const escaped = argument.replace(/%/gu, '%%').replace(/[\\"`$]/gu, '\\$&');

  return `"${escaped.replace(/\\/gu, '\\\\')}"`;
}

/**
 * GIO проверяет существование executable до раскрытия %% и отклоняет путь с процентом.
 * Только в этом случае env передаёт буквальный путь как аргумент, не запуская shell.
 */
export function desktopCommand(executable: string, args: string[] = []): string {
  const command = executable.includes('%')
    ? ['/usr/bin/env', '--', executable, ...args] : [executable, ...args];

  return command.map(desktopExec).join(' ');
}
