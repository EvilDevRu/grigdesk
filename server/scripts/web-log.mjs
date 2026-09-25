#!/usr/bin/env node
// Локальный просмотр дневного NDJSON без запуска HTTP-сервера.
import { config } from '../src/config.ts';
import { parseLevel, readWebLog } from '../src/lib/webLog/reader.ts';

const USAGE = 'Использование: web-log.mjs [--day YYYY-MM-DD | --since 30m|2h|1d] [--level warn]'
  + " [--ev 'api.*'] [--tab <id>] [--page <id>] [--dump] [--json]";
const VALUE_FLAGS = new Set(['--day', '--since', '--level', '--ev', '--tab', '--page']);
const SINCE_SCALE = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Интервал `--since` вида 30m, 2h или 1d отсчитывается от текущего момента. */
function sinceOf(value) {
  const match = /^(\d{1,5})(m|h|d)$/u.exec(value);

  if (!match) {
    throw new Error('Для --since нужен интервал вроде 30m, 2h или 1d');
  }

  return new Date(Date.now() - Number(match[1]) * SINCE_SCALE[match[2]]);
}

/**
 * Разбор аргументов строгий: неизвестный флаг или флаг без значения — ошибка
 * с понятным текстом, а не молчаливый пропуск фильтра.
 */
function argumentsOf(argv) {
  const options = { dir: config.webLogDir };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (flag === '--json' || flag === '--dump') {
      options[flag.slice(2)] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(`Неизвестный аргумент: ${flag}`);
    }

    const value = argv[index + 1];

    if (!value) {
      throw new Error(`Для ${flag} нужно значение`);
    }

    index += 1;

    if (flag === '--since') {
      options.since = sinceOf(value);
    } else if (flag === '--level') {
      options.level = parseLevel(value);
    } else {
      options[flag.slice(2)] = value;
    }
  }

  return options;
}

function escapeTerminal(value) {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/gu,
    (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Строка для человека: время окна, уровень, событие, маршрут и ключ записи.
 * Время приёма сервером (`rx`) и полный конверт есть в режиме `--json`.
 */
function textLine(row, prefix = '') {
  const { entry } = row;
  const duplicate = row.duplicates ? ` повторов: ${row.duplicates}` : '';

  return escapeTerminal(`${prefix}${entry.t} ${entry.lvl.padEnd(5)} ${entry.ev} ${entry.route}`
    + ` ${entry.page}:${entry.seq}${duplicate} ${JSON.stringify(entry.data)}`);
}

/**
 * В тексте предыстория печатается сразу под своей записью с отступом, по
 * порядку времени; в NDJSON каждая строка дампа несёт ссылку contextOf.
 */
async function main() {
  const options = argumentsOf(process.argv.slice(2));
  const warn = (message) => process.stderr.write(`${escapeTerminal(message)}\n`);
  let context = [];

  for await (const row of readWebLog({ ...options, warn })) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        ...row.entry,
        rx: row.rx,
        duplicates: row.duplicates,
        ...(row.contextOf ? { contextOf: row.contextOf } : {}),
      })}\n`);
      continue;
    }
    if (row.contextOf) {
      context.push(row);
      continue;
    }

    process.stdout.write(`${textLine(row)}\n`);

    if (context.length) {
      process.stdout.write(`  предыстория (${context.length}):\n`);

      for (const item of context) {
        process.stdout.write(`${textLine(item, '    ')}\n`);
      }
    }

    context = [];
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);

  process.stderr.write(`${escapeTerminal(message)}\n${USAGE}\n`);
  process.exitCode = 2;
});
