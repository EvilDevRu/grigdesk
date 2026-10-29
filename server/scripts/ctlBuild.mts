import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { desktopRuntimePath, parseRuntimeDescriptor } from '../../shared/desktop/desktopRuntime.ts';
import { ensureNodeArchive, readNodeRuntime } from '../../shared/node/nodeRuntime.ts';
import { downloadFile } from '../../shared/node/seaBuild.ts';

/**
 * Сервер и исполнитель проверяют admission одного режима потребителя.
 * Из .env извлекается только настройка GLM; файл не исполняется и ключи не выводятся.
 */
export async function consumerGlmMode(
  envFile: string,
  env: Record<string, string | undefined> = process.env,
): Promise<'api' | 'coding-plan'> {
  let mode = env.GRIGDESK_GLM_API_MODE;

  if (mode === undefined) {
    const source = await readFile(envFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return '';
    });

    mode = parseEnv(source).GRIGDESK_GLM_API_MODE;
  }

  return mode === 'coding-plan' ? 'coding-plan' : 'api';
}

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
 * Shell разделяет подготовку сборщика, проверку текущего выбора и публикацию намерения.
 * Последнее действие вызывается только после всех успешных стадий полной установки.
 */
async function main(): Promise<void> {
  const [command, value, ...extra] = process.argv.slice(2);

  if (!value || extra.length > 0
    || !['prepare-runtime', 'check-desktop', 'queue-desktop', 'glm-mode'].includes(command ?? '')) {
    process.stderr.write('Ожидается prepare-runtime <cache>, check-desktop <ELF>, '
      + 'queue-desktop <ELF> или glm-mode <env-файл>\n');
    process.exitCode = 2;

    return;
  }

  if (command === 'glm-mode') {
    process.stdout.write(`${await consumerGlmMode(value)}\n`);
  } else if (command === 'prepare-runtime') {
    await prepareBuildRuntime(value);
  } else if (command === 'queue-desktop') {
    const { queueBuiltServer } = await import('../src/lib/builtServerSelection.ts');
    const result = await queueBuiltServer({
      env: process.env,
      home: process.env.HOME ?? '',
      root: path.dirname(path.dirname(value)),
    });

    process.stdout.write(`${result}\n`);
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
