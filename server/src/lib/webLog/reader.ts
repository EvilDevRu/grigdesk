import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { projectWebLogEntry } from '../../../../shared/web-log/webLogContracts.ts';

import type { WebLogEntry, WebLogKey, WebLogLevel } from '../../../../shared/web-log/webLogContracts.ts';

import { validUtcDay, webLogFiles } from './files.ts';
import { closeLogSnapshot, snapshotChunks, snapshotLogs } from '../../../../shared/node/logArchives.ts';
import type { LogSnapshot } from '../../../../shared/node/logArchives.ts';

export type ReaderOptions = {
  dir: string;
  day?: string;
  since?: Date;
  level?: WebLogLevel;
  ev?: string;
  tab?: string;
  page?: string;
  dump?: boolean;
  now?: () => Date;
  maxIndex?: number;
  warn?: (message: string) => void;
};

export type ReadWebLogRow = {
  entry: WebLogEntry;
  rx: string;
  duplicates: number;
  contextOf?: WebLogKey;
};

type NumberedLine = { number: number; text: string };

type IndexState = {
  count: number;
  firstRx: string;
  seen: boolean;
};

const LEVEL_ORDER: Record<WebLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MAX_LINE_CHARS = 128 * 1024;

function keyOf(entry: WebLogKey): string {
  return `${entry.page}:${entry.seq}`;
}

/** Шаблон события допускает только `*`; остальные символы сравниваются буквально. */
function eventMatches(event: string, pattern: string | undefined): boolean {
  if (!pattern) {
    return true;
  }

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*');

  return new RegExp(`^${escaped}$`, 'u').test(event);
}

/**
 * Какие дневные файлы читать: явный день, дни начиная с даты `--since`
 * (имя файла — UTC-день приёма) либо сегодняшний UTC-день.
 */
async function sourceSnapshot(options: ReaderOptions): Promise<LogSnapshot> {
  const groups = await webLogFiles(options.dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return new Map<string, string[]>();
  });
  let first: string;

  if (options.day) {
    if (!validUtcDay(options.day)) {
      throw new Error('Некорректный UTC-день');
    }

    return snapshotLogs(options.dir, groups.get(options.day) ?? []);
  }
  if (!options.since) {
    first = (options.now ?? (() => new Date()))().toISOString().slice(0, 10);

    return snapshotLogs(options.dir, groups.get(first) ?? []);
  }

  first = options.since.toISOString().slice(0, 10);

  const names = [...groups.entries()].filter(([day]) => day >= first).flatMap(([, files]) => files);

  return snapshotLogs(options.dir, names);
}

/**
 * Между чтением каталога и open другая программа может завершить ротацию.
 * Повтор собирает новый состав вместо ошибки на уже переименованном файле.
 */
async function stableSnapshot(options: ReaderOptions): Promise<LogSnapshot> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sourceSnapshot(options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 2) {
        throw error;
      }
    }
  }
}

/**
 * Строки читаются потоково. Хвост без перевода строки не является подтверждённой
 * записью; сообщение в stderr содержит только номер, без сырого содержимого.
 */
async function* lines(
  snapshot: LogSnapshot, file: string, warn: (message: string) => void,
): AsyncGenerator<NumberedLine> {
  const name = path.basename(file);
  let rest = '';
  let number = 0;
  const decoder = new StringDecoder('utf8');

  try {
    for await (const chunk of snapshotChunks(snapshot)) {
      rest += decoder.write(chunk);

      let newline = rest.indexOf('\n');

      while (newline >= 0) {
        const text = rest.slice(0, newline);

        rest = rest.slice(newline + 1);
        number += 1;

        if (text.length > MAX_LINE_CHARS) {
          warn(`${name}: строка ${number} слишком длинная`);
        } else {
          yield { number, text };
        }

        newline = rest.indexOf('\n');
      }

      if (rest.length > MAX_LINE_CHARS) {
        rest = '';
        warn(`${name}: строка ${number + 1} слишком длинная`);
      }
    }

    if (rest.length) {
      warn(`${name}: строка ${number + 1} — неполный хвост`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Строка файла снова проходит общую проекцию: повреждённая или чужая запись
 * пропускается с номером строки, её содержимое в вывод не попадает.
 */
function parseLine(
  line: NumberedLine,
  file: string,
  warn: (message: string) => void,
): ReadWebLogRow | null {
  try {
    const raw: unknown = JSON.parse(line.text);
    const row = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : null;
    const entry = row ? projectWebLogEntry(row) : null;

    if (!row || typeof row.rx !== 'string' || !Number.isFinite(Date.parse(row.rx)) || !entry) {
      throw new Error('bad_line');
    }

    return {
      entry,
      rx: row.rx,
      duplicates: 0,
    };
  } catch {
    warn(`${path.basename(file)}: строка ${line.number} повреждена`);

    return null;
  }
}

/**
 * Все строки выбранных дней по порядку, уже прошедшие проекцию. С `--since`
 * отсекаются записи, принятые сервером раньше начала интервала.
 */
async function* source(options: ReaderOptions, snapshot: LogSnapshot): AsyncGenerator<ReadWebLogRow> {
  const warn = options.warn ?? (() => undefined);

  for (const part of snapshot.parts) {
    const file = part.name;

    for await (const line of lines({ parts: [part] }, file, warn)) {
      const row = parseLine(line, file, warn);

      if (row && (!options.since || Date.parse(row.rx) >= options.since.getTime())) {
        yield row;
      }
    }
  }
}

/** Фильтры выборки: порог уровня, шаблон события, вкладка и документ. */
function selected(row: ReadWebLogRow, options: ReaderOptions): boolean {
  if (options.level && LEVEL_ORDER[row.entry.lvl] < LEVEL_ORDER[options.level]) {
    return false;
  }

  return eventMatches(row.entry.ev, options.ev)
    && (!options.tab || row.entry.tab === options.tab)
    && (!options.page || row.entry.page === options.page);
}

/**
 * Два потоковых прохода позволяют сообщить число дублей при первом выводе.
 * Индекс ограничен; после потолка новые ключи выводятся без скрытого пропуска.
 */
export async function* readWebLog(options: ReaderOptions): AsyncGenerator<ReadWebLogRow> {
  const snapshot = await stableSnapshot(options);

  try {
    yield* readSnapshot(options, snapshot);
  } finally {
    await closeLogSnapshot(snapshot);
  }
}

/**
 * Оба прохода используют одни и те же inode и зафиксированные размеры.
 * Между подсчётом дублей и выдачей ротация не меняет состав выборки.
 */
async function* readSnapshot(options: ReaderOptions, snapshot: LogSnapshot): AsyncGenerator<ReadWebLogRow> {
  const warn = options.warn ?? (() => undefined);

  if (options.ev && !/^[A-Za-z0-9.*_-]+$/u.test(options.ev)) {
    throw new Error('Некорректный шаблон события');
  }

  const maxIndex = options.maxIndex ?? 100_000;
  const counts = new Map<string, IndexState>();
  let warnedLimit = false;

  for await (const row of source({ ...options, warn: () => undefined }, snapshot)) {
    const key = keyOf(row.entry);
    const state = counts.get(key);

    if (state) {
      state.count += 1;
    } else if (counts.size < maxIndex) {
      counts.set(key, {
        count: 1,
        firstRx: row.rx,
        seen: false,
      });
    } else if (!warnedLimit) {
      warn('Индекс дедупликации исчерпан; новые ключи могут повторяться.');
      warnedLimit = true;
    }
  }

  for await (const row of source(options, snapshot)) {
    const state = counts.get(keyOf(row.entry));

    if (state?.seen) {
      continue;
    }
    if (state) {
      state.seen = true;
      row.rx = state.firstRx;
      row.duplicates = state.count - 1;
    }
    if (!selected(row, options)) {
      continue;
    }
    if (options.dump && row.entry.dump) {
      for (const context of row.entry.dump.entries) {
        yield {
          entry: context,
          rx: row.rx,
          duplicates: 0,
          contextOf: {
            page: row.entry.page,
            seq: row.entry.seq,
          },
        };
      }
    }

    yield row;
  }
}

/**
 * Порог уровня из аргумента CLI. Неизвестное значение — ошибка аргументов
 * с перечнем допустимых уровней.
 */
export function parseLevel(value: string): WebLogLevel {
  if (!(value in LEVEL_ORDER)) {
    throw new Error('Некорректный уровень: нужен debug, info, warn или error');
  }

  return value as WebLogLevel;
}

