import { appendFile, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface GlmSmokeHttpError {
  httpStatus: number | null;
  errorText: string;
}

interface ObserverOptions {
  file: string;
  endpoint?: string;
  roots: string[];
}

/**
 * Собирает значения для маскирования, не меняя выбор ключа модели.
 * Короткие служебные флаги с TOKEN/KEY в имени не должны портить код ошибки 1113.
 */
export function glmSmokeSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  const selected = /^(?:ZAI_API_KEY|ZAI_CODING_API_KEY|GRIGDESK_GLM_ROUTE_KEY)$/u;

  return Object.entries(env)
    .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/u.test(name) && value
      && (selected.test(name) || value.length >= 8))
    .map(([, value]) => value!);
}

/**
 * Полный текст ошибки сохраняется без усечения, но секреты, контакты и приватные пути скрываются.
 * В отличие от кратких сообщений runner-а, диагностическое тело не ограничивается 8192 символами.
 */
export function cleanGlmSmokeDiagnostic(
  value: unknown,
  secrets: readonly string[],
  roots: readonly string[],
): string {
  let text = String(value ?? '');
  const privateField = new RegExp([
    '("(?:api_?key|secret|token|phone|customerId|userId|accountId|request_id)"\\s*:\\s*)',
    '(?:"(?:\\\\.|[^"\\\\])*"|-?\\d+(?:\\.\\d+)?|true|false|null)',
  ].join(''), 'giu');

  for (const secret of secrets.filter(Boolean)) {
    text = text.replaceAll(secret, '<secret>');
  }

  for (const root of roots.filter(Boolean)) {
    text = text.replaceAll(root, '<path>');
  }

  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer <secret>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '<email>')
    .replace(privateField, '$1"<private>"');
}

/**
 * Наблюдатель оборачивает исходный fetch без смены endpoint, заголовков и успешного потока.
 * Записываются только ошибки точного модельного адреса; prompt и ответы модели не сохраняются.
 */
export function installGlmSmokeHttpObserver(options: ObserverOptions): () => void {
  const original = globalThis.fetch;
  const target = options.endpoint
    ? `${options.endpoint.replace(/\/+$/u, '')}/chat/completions` : null;
  const secrets = glmSmokeSecrets(process.env);

  const record = async (httpStatus: number | null, errorText: unknown) => {
    const item: GlmSmokeHttpError = {
      httpStatus,
      errorText: cleanGlmSmokeDiagnostic(errorText, secrets, options.roots),
    };

    await appendFile(options.file, `${JSON.stringify(item)}\n`, { mode: 0o600 });
  };

  /**
   * Ошибка читается из клона Response, поэтому клиент сохраняет исходное тело и HTTP-статус.
   * Сетевое исключение записывается отдельно и пробрасывается без подмены причины.
   */
  const observed: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const parsed = new URL(url);
    const modelRequest = target ? url === target
      : parsed.origin === 'https://api.z.ai' && parsed.pathname.endsWith('/chat/completions');

    if (!modelRequest) {
      return original(input, init);
    }

    let response: Response;

    try {
      response = await original(input, init);
    } catch (error) {
      await record(null, (error as Error).message);

      throw error;
    }

    if (!response.ok) {
      await record(response.status, await response.clone().text());
    }

    return response;
  };

  globalThis.fetch = observed;

  return () => {
    if (globalThis.fetch === observed) {
      globalThis.fetch = original;
    }
  };
}

/**
 * Отдельный плагин ручного smoke устанавливает наблюдатель в настоящий процесс Harness.
 * Offline-сторож fetch загружается первым и сохраняет запрет внешней сети.
 */
export async function writeGlmSmokeHttpObserver(
  root: string,
  endpoint?: string,
  existingGuard?: string,
) {
  const file = path.join(root, 'model-errors.jsonl');
  const plugin = path.join(root, 'model-observer.mjs');
  const options: ObserverOptions = {
    file,
    endpoint,
    roots: [root, os.homedir()],
  };
  const guardUrl = existingGuard ? pathToFileURL(existingGuard).href : null;
  const source = [
    `import { installGlmSmokeHttpObserver } from ${JSON.stringify(import.meta.url)};`,
    'export const name = "grigdesk-glm-egress-guard";',
    '/**',
    ' * Наблюдение за HTTP-ошибками не меняет маршрут и допуск модели.',
    ' * Перед ним сохраняется переданный smoke сторож внешней сети.',
    ' */',
    'export async function apply(...args) {',
    ...(guardUrl ? [
      `  const guard = await import(${JSON.stringify(guardUrl)});`,
      '  await guard.apply(...args);',
    ] : []),
    `  installGlmSmokeHttpObserver(${JSON.stringify(options)});`,
    '}',
    '',
  ].join('\n');

  await writeFile(file, '', { mode: 0o600 });
  await writeFile(plugin, source, { mode: 0o600 });

  return { file, plugin };
}

/**
 * Итоговый отчёт повторно очищает накопленные ошибки ключами родительского процесса.
 * Даже секрет из старого окружения не попадает в сохраняемый человеком JSON.
 */
export async function readGlmSmokeHttpErrors(
  file: string,
  env: Readonly<Record<string, string | undefined>>,
  root: string,
): Promise<GlmSmokeHttpError[]> {
  const secrets = glmSmokeSecrets(env);
  const text = await readFile(file, 'utf8');

  return text.split('\n').filter(Boolean).map((line) => {
    const item = JSON.parse(line) as GlmSmokeHttpError;

    return {
      httpStatus: item.httpStatus,
      errorText: cleanGlmSmokeDiagnostic(item.errorText, secrets, [root, os.homedir()]),
    };
  });
}
