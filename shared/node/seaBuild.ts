import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

import type { NodeRuntime } from './nodeRuntime.ts';

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
 * Возвращает новый SEA config с ресурсами, лицензией и запретом расширения аргументов Node.
 * Имена ресурсов относятся к work-папке; импорт модуля ничего не собирает.
 */
export function seaConfig(assets: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  return {
    main: 'bundle.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: 'none',
    assets: {
      ...assets,
      'NODE-LICENSE': 'LICENSE',
    },
  };
}

/**
 * Встраивает blob в рабочую копию Node и проверяет конечную подпись Mach-O.
 * Кэш официального Node и файлы прежней сборки остаются вне work.
 */
export async function injectSea(input: {
  target: NodeRuntime['platform'];
  work: string;
  node: string;
  postject: string;
  executable: string;
  fuse: string;
  run: (file: string, args: string[], options: { cwd: string }) => Promise<unknown>;
}): Promise<void> {
  const { target, work, node, postject, executable, fuse, run } = input;
  const options = { cwd: work };
  const mac = target === 'darwin-arm64';

  if (mac) {
    await run('/usr/bin/codesign', ['--remove-signature', executable], options);
  }

  const args = [postject, executable, 'NODE_SEA_BLOB', 'sea-prep.blob', '--sentinel-fuse', fuse];

  if (mac) {
    args.push('--macho-segment-name', 'NODE_SEA');
  }

  await run(node, args, options);

  if (mac) {
    await run('/usr/bin/codesign', ['--force', '--sign', '-', executable], options);
    await run('/usr/bin/codesign', ['--verify', '--strict', executable], options);
  }
}

/**
 * Скачивает архив потоком после успешного HTTP-статуса, с общим сроком 120 секунд.
 * Отказ отменяет ненужное тело; файловые и сетевые ошибки передаются сборщику.
 */
export async function downloadFile(url: string, file: string, signal?: AbortSignal): Promise<void> {
  const deadline = AbortSignal.timeout(120000);
  const response = await fetch(url, {
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
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
