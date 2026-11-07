// Загружаются только два заданных адаптерами источника; браузер URL не передаёт.
// Последняя успешная внешняя схема переживает сетевой сбой с прежним отпечатком.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readSettingsJson } from './probe.ts';

const execFileAsync = promisify(execFile);
const SOURCES = new Set([
  'https://developers.openai.com/codex/config-schema.json',
  'https://json.schemastore.org/claude-code-settings.json',
]);
const cache = new Map<string, { at: number; value: unknown }>();

/**
 * Native fetch ограничивает время и поток; curl сохраняет поддержку proxy окружения.
 * Обе реализации возвращают только разобранную схему, без текста сетевой ошибки.
 */
export async function readPublishedSettingsSchema(
  url: string,
  signal: AbortSignal,
  { refresh = false } = {},
): Promise<unknown> {
  if (!SOURCES.has(url)) {
    throw new Error('Источник внешней схемы не разрешён адаптером');
  }

  const previous = cache.get(url);

  if (!refresh && previous && Date.now() - previous.at < 3_600_000) {
    return previous.value;
  }

  try {
    let value: unknown;

    try {
      value = await readSettingsJson(
        await fetch(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        }),
      );
    } catch {
      signal.throwIfAborted();

      const { stdout } = await execFileAsync(
        'curl',
        [
          '--fail',
          '--location',
          '--silent',
          '--show-error',
          '--max-time',
          '5',
          '--max-filesize',
          '2097152',
          '--proto',
          '=https',
          '--proto-redir',
          '=https',
          url,
        ],
        {
          signal,
          timeout: 6_000,
          maxBuffer: 2_097_152,
        },
      );

      value = JSON.parse(stdout);
    }

    cache.set(url, { at: Date.now(), value });

    return value;
  } catch {
    return previous?.value;
  }
}
