import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { desktopRuntimePath, parseRuntimeDescriptor } from '../../shared/desktop/desktopRuntime.ts';
import { ensureNodeArchive, readNodeRuntime } from '../../shared/node/nodeRuntime.ts';
import { downloadFile } from '../../shared/node/seaBuild.ts';

/**
 * Подготавливает локальный вход сборщика штатным кэшем Node с проверкой закреплённого SHA.
 * Три попытки с паузой 30 секунд действуют только при отсутствии проверенного архива.
 */
export async function prepareBuildRuntime(cacheDir: string, options: {
  manifestPath?: string;
  download?: typeof downloadFile;
  pauseMs?: number;
} = {}): Promise<string> {
  const manifest = options.manifestPath
    ?? fileURLToPath(new URL('../build/node-runtime.json', import.meta.url));
  const runtime = readNodeRuntime(
    JSON.parse(await readFile(manifest, 'utf8')), 'server/build/node-runtime.json',
  );

  return ensureNodeArchive(runtime, cacheDir, {
    download: options.download ?? downloadFile,
    attempts: 3,
    pauseMs: options.pauseMs ?? 30_000,
  });
}

/**
 * Читает только публичное описание установки окна через общий decoder и формулу пути.
 * Отсутствующее или непригодное описание требует подсказки, но никогда не переписывается.
 */
export async function desktopUsesBinary(input: {
  env: Record<string, string | undefined>;
  home: string;
  binary: string;
}): Promise<boolean> {
  const text = await readFile(desktopRuntimePath(input), 'utf8').catch(() => '');
  const descriptor = parseRuntimeDescriptor(text);

  return descriptor?.version === 4 && descriptor.binary === input.binary;
}

/**
 * Shell вызывает два узких действия; импорт для тестов не запускает их автоматически.
 * Проверка descriptor возвращает только статус для подсказки после успешной установки.
 */
async function main(): Promise<void> {
  const [command, value, ...extra] = process.argv.slice(2);

  if (!value || extra.length > 0 || !['prepare-runtime', 'check-desktop'].includes(command ?? '')) {
    process.stderr.write('Ожидается prepare-runtime <cache> или check-desktop <ELF>\n');
    process.exitCode = 2;

    return;
  }

  if (command === 'prepare-runtime') {
    await prepareBuildRuntime(value);
  } else {
    process.exitCode = await desktopUsesBinary({
      env: process.env,
      home: process.env.HOME ?? '',
      binary: value,
    }) ? 0 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    process.stderr.write(`Подготовка сборки не удалась: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
