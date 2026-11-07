#!/usr/bin/env node
// Тонкий CLI общего разбора ошибок: контракты событий совпадают с серверной диагностикой.
// Чужие stdout-команды не распознаются как ошибки провайдера; чтение имеет предел.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

import { classifyCodexFailure } from '../../server/src/lib/runnerFailure.ts';

/**
 * Не открываем ссылку, устройство или FIFO из доступного провайдеру каталога.
 * Oversize остаётся неизвестным исходом, а не поводом угадывать по обрезанному потоку.
 */
function boundedFile(file, limit) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = fstatSync(fd);

    if (!stat.isFile() || stat.size > limit) {
      throw new Error('unsupported file');
    }

    const bytes = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);

    if (bytesRead !== bytes.length || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
      throw new Error('unstable file');
    }

    return bytes.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const [, , runDir, rcValue] = process.argv;

try {
  const meta = Object.fromEntries(boundedFile(path.join(runDir, 'meta.env'), 65536)
    .split('\n').filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const raw = boundedFile(path.join(runDir, 'events.jsonl'), 64 * 1024 * 1024);
  const verified = meta.FIXTURE_VERIFIED === '1' || meta.SOURCE === 'runtime';

  process.stdout.write(`${classifyCodexFailure(raw, Number(rcValue), verified)}\n`);
} catch {
  process.stdout.write('unknown\n');
}
