/**
 * Только оформление: части в исходном порядке складываются в исходную команду.
 * Разделяем верхний уровень shell; сложные подстановки и heredoc оставляем целиком,
 * чтобы оформление не выдавало содержимое строки или данных за отдельную команду.
 */
export function sshCommandParts(command: string): string[] {
  if (!command || /`|\$[({]|<</u.test(command)) {
    return command ? [command] : [];
  }

  const parts: string[] = [];
  const groups: string[] = [];
  let quote = '';
  let comment = false;
  let start = 0;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (comment && char !== '\n') {
      continue;
    }

    comment = false;

    if (char === '\\' && quote !== "'") {
      index += 1;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = '';
      }

      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === '#' && (index === 0 || /[\s;&|()]/u.test(command[index - 1] || ''))) {
      comment = true;
      continue;
    }

    if (char === '(' || char === '{') {
      groups.push(char);
    } else if (char === ')' || char === '}') {
      const opener = char === ')' ? '(' : '{';

      if (groups.pop() !== opener) {
        return [command];
      }
    }

    if (groups.length) {
      continue;
    }

    const pair = command.slice(index, index + 2);
    const width = pair === '&&' || pair === '||'
      ? 2 : char === ';' || char === '\n' ? 1 : 0;

    if (!width) {
      continue;
    }

    const end = index + width;

    if (command.slice(start, end).trim()) {
      parts.push(command.slice(start, end));
      start = end;
    }

    index = end - 1;
  }

  if (quote || groups.length || !parts.length) {
    return [command];
  }

  const tail = command.slice(start);

  if (tail.trim()) {
    parts.push(tail);
  } else {
    parts[parts.length - 1] = (parts.at(-1) || '') + tail;
  }

  return parts;
}
