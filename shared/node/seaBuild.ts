import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

/**
 * Строит имя официального архива из уже проверенного manifest пакета.
 * Политика допустимых версий и сообщение об ошибке остаются у сборщика.
 */
export function nodeArchive(runtime: { version: string; platform: string }): {
  name: string;
  directory: string;
  url: string;
} {
  const directory = `node-v${runtime.version}-${runtime.platform}`;
  const name = `${directory}.tar.xz`;

  return {
    name,
    directory,
    url: `https://nodejs.org/dist/v${runtime.version}/${name}`,
  };
}

/**
 * Возвращает новый SEA config с лицензией и запретом расширения аргументов Node.
 * Имена ресурсов относятся к work-папке; импорт модуля ничего не собирает.
 */
export function seaConfig(): Record<string, unknown> {
  return {
    main: 'bundle.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: 'none',
    assets: { 'NODE-LICENSE': 'LICENSE' },
  };
}

/**
 * Скачивает архив потоком после успешного HTTP-статуса, с общим сроком 120 секунд.
 * Отказ отменяет ненужное тело; файловые и сетевые ошибки передаются сборщику.
 */
export async function downloadFile(url: string, file: string): Promise<void> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok || !response.body) {
    await response.body?.cancel();

    throw new Error(`Не удалось скачать Node: HTTP ${response.status}`);
  }

  await pipeline(
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
    createWriteStream(file),
  );
}
