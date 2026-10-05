export const SHELL_FORMAT_MIN_LENGTH = 80;

interface ShellPart {
  text: string;
  operator: string;
}

/**
 * Конечный пробел может быть частью экранированного слова.
 * Удаляем только пробелы и табуляции без нечётного числа обратных косых черт перед ними.
 */
function trimPart(text: string): string {
  let end = text.length;

  while (end > 0 && /[ \t]/.test(text[end - 1] ?? '')) {
    let slashes = 0;

    for (let index = end - 2; index >= 0 && text[index] === '\\'; index -= 1) {
      slashes += 1;
    }

    if (slashes % 2 === 1) {
      break;
    }

    end -= 1;
  }

  return text.slice(0, end).replace(/^[ \t]+/, '');
}

/**
 * Собираем цепочку с операторами на конце предыдущей строки.
 * Точка с запятой завершает команду и снимает отступ следующей строки.
 */
function joinParts(parts: ShellPart[]): string {
  const lines: string[] = [];
  let indent = '';

  for (const part of parts) {
    const body = trimPart(part.text);

    if (!body) {
      if (part.operator === ';') {
        indent = '';
      }

      continue;
    }

    if (part.operator === ';' || part.operator === '') {
      lines.push(indent + body);
      indent = '';

      continue;
    }

    lines.push(`${indent}${body} ${part.operator}`);
    indent = '  ';
  }

  return lines.join('\n');
}

/**
 * Посимвольный сканер делит только операторы на нулевой глубине вне кавычек.
 * При неоднозначной или незакрытой конструкции возвращает исходник целиком.
 */
export function formatShellCommand(command: string): string {
  if (command.includes('\n') || command.length <= SHELL_FORMAT_MIN_LENGTH) {
    return command;
  }

  if (command.includes('${') || command.includes('$[') || command.includes("$'")) {
    return command;
  }

  const parts: ShellPart[] = [];
  let current = '';
  let quote = '';
  let depth = 0;
  let brackets = 0;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (quote) {
      current += char;

      if (quote === '"' && (char === '`' || (char === '$' && next === '('))) {
        return command;
      }

      if (char === '\\' && quote === '"') {
        current += next ?? '';
        index += 1;

        continue;
      }

      if (char === quote) {
        quote = '';
      }

      continue;
    }

    if (char === '\\') {
      current += char + (next ?? '');
      index += 1;

      continue;
    }

    if (char === '#' && (current === '' || /\s$/.test(current)) && depth === 0 && brackets === 0) {
      current += command.slice(index);

      break;
    }

    if (char === '[' && next === '[' && (current === '' || /\s$/.test(current))) {
      brackets += 1;
      current += '[[';
      index += 1;

      continue;
    }

    if (char === ']' && next === ']' && brackets > 0) {
      brackets -= 1;
      current += ']]';
      index += 1;

      continue;
    }

    if (char === '<' && next === '<') {
      if (command[index + 2] !== '<') {
        return command;
      }

      current += '<<<';
      index += 2;

      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;

      continue;
    }

    if (char === '(') {
      depth += 1;
      current += char;

      continue;
    }

    if (char === ')') {
      depth -= 1;
      current += char;

      if (depth < 0) {
        return command;
      }

      continue;
    }

    if (depth === 0 && brackets === 0) {
      if (char === ';' && (next === ';' || next === '&')) {
        return command;
      }

      const pair = char + (next ?? '');
      let operator = '';

      if (pair === '&&' || pair === '||') {
        operator = pair;
      } else if (char === '|' && command[index - 1] !== '>') {
        operator = next === '&' ? '|&' : '|';
      } else if (char === ';') {
        operator = ';';
      }

      if (operator) {
        parts.push({ text: current, operator });
        current = '';
        index += operator.length - 1;

        continue;
      }
    }

    current += char;
  }

  if (quote || depth !== 0 || brackets !== 0 || parts.length === 0) {
    return command;
  }

  parts.push({ text: current, operator: '' });

  return joinParts(parts);
}
