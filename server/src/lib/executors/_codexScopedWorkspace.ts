import { execFile } from '../providerInstall/externalCliProcess.ts';
import { createRequire } from 'node:module';
import { promises as fs, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRecord } from '../../../../shared/lib/objects.ts';
import type { JsonValue } from '../../../../shared/chat/providerSettingsContracts.ts';

type WorkspaceProtocol = 'legacy' | 'profile' | null;

const cache = new Map<string, { at: number; value: Promise<WorkspaceProtocol> }>();

/**
 * Старый CLI ограничивает чтение через SandboxPolicy, новый — именованным профилем.
 * Проверяем экспериментальную схему всех границ до допуска модели в триаж.
 */
export async function codexWorkspaceProtocol(bin: string): Promise<WorkspaceProtocol> {
  const cached = cache.get(bin);

  if (cached && Date.now() - cached.at < 60_000) {
    return cached.value;
  }

  const value = (async (): Promise<WorkspaceProtocol> => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-codex-scope-'));

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(bin, ['app-server', 'generate-ts', '--experimental', '--out', directory], {
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        }, (error) => error ? reject(error) : resolve());
      });

      const policy = await fs.readFile(path.join(directory, 'v2', 'SandboxPolicy.ts'), 'utf8');

      if (/\breadOnlyAccess\b/u.test(policy)) {
        return 'legacy';
      }

      const schemas = await Promise.all(['ThreadStartParams', 'ThreadResumeParams', 'TurnStartParams']
        .map((name) => fs.readFile(path.join(directory, 'v2', `${name}.ts`), 'utf8')));
      const response = await fs.readFile(path.join(directory, 'v2', 'ThreadStartResponse.ts'), 'utf8');

      return schemas.every((schema) => /\bpermissions\?\s*:\s*string\b/u.test(schema))
        && /\bactivePermissionProfile\s*:/u.test(response) ? 'profile' : null;
    } catch {
      return null;
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  })();

  cache.set(bin, { at: Date.now(), value });

  return value;
}

/**
 * :minimal не включает установленный в home бинарь Codex: bubblewrap должен прочитать его.
 * Разрешаем только сам executable и обнаруженные пакеты CLI, без всего npm-prefix или home.
 */
function runtimePaths(bin: string, env: NodeJS.ProcessEnv): string[] {
  const candidates = path.isAbsolute(bin) ? [bin]
    : (env.PATH || '').split(path.delimiter).filter(path.isAbsolute).map((dir) => path.join(dir, bin));
  let executable = '';

  for (const candidate of candidates) {
    try {
      executable = realpathSync(candidate);
      break;
    } catch {
      // PATH может содержать отсутствующие записи; следующая остаётся кандидатом.
    }
  }

  if (!executable) {
    throw new Error('Не найден исполняемый файл Codex для изолированного запуска.');
  }

  const roots = [executable];
  let directory = path.dirname(executable);

  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const manifestPath = path.join(directory, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

      if (manifest.name === '@openai/codex') {
        roots.push(directory);

        const require = createRequire(manifestPath);

        for (const name of Object.keys(manifest.optionalDependencies || {})) {
          if (!name.startsWith('@openai/codex-')) {
            continue;
          }

          try {
            roots.push(path.dirname(realpathSync(require.resolve(`${name}/package.json`))));
          } catch {
            // Пакеты остальных платформ не установлены и не расширяют доступ.
          }
        }

        break;
      }
    } catch {
      // Нативная поставка и тестовый executable могут не принадлежать npm-пакету.
    }

    directory = path.dirname(directory);
  }

  return [...new Set(roots)];
}

/**
 * Профиль начинается с запрета чтения хоста; код и входы доступны только для чтения.
 * Отдельный каталог результата — единственное место записи, включая временные файлы.
 */
export function codexWorkspaceProfile(
  bin: string,
  env: NodeJS.ProcessEnv,
  readableRoots: string[],
  writableRoots: string[],
): Record<string, JsonValue> {
  return {
    filesystem: {
      ':root': 'deny',
      ':minimal': 'read',
      ...Object.fromEntries([...runtimePaths(bin, env), ...readableRoots].map((root) => [root, 'read'])),
      ...Object.fromEntries(writableRoots.map((root) => [root, 'write'])),
    },
    network: { enabled: false },
  };
}

/**
 * Пустая MCP-таблица сливается с пользовательской конфигурацией и не выключает её записи.
 * До открытия thread явно запрещаем каждый унаследованный сервер, сохраняя непрозрачные имена.
 */
export function codexWorkspaceMcpOverrides(value: unknown): Record<string, JsonValue> {
  if (!isRecord(value) || !isRecord(value.config)) {
    throw new Error('Codex не подтвердил конфигурацию изолированного запуска.');
  }

  const servers = value.config.mcp_servers;

  if (servers != null && !isRecord(servers)) {
    throw new Error('Codex вернул непроверяемую конфигурацию MCP.');
  }

  return Object.fromEntries(Object.keys(servers ?? {}).map((name) => [name, { enabled: false }]));
}

/**
 * Именованный профиль не должен получить инструменты внешнего MCP через настройки CLI.
 * Неполный каталог и любой сервер без подтверждённого disabled закрывают постановку.
 */
export function assertCodexWorkspaceMcp(value: unknown): void {
  const disabled = isRecord(value) && Array.isArray(value.data) && value.data.every((server) =>
    isRecord(server) && server.runtimeStatus === 'disabled'
      && isRecord(server.tools) && Object.keys(server.tools).length === 0
      && Array.isArray(server.resources) && server.resources.length === 0
      && Array.isArray(server.resourceTemplates) && server.resourceTemplates.length === 0);

  if (!disabled || value.nextCursor != null) {
    throw new Error('Codex не подтвердил отключение внешних MCP триажа.');
  }
}

/**
 * Native readback обязан подтвердить выбранный профиль и его полные grants до prompt.
 * Лишний grant, наследование или подмена managed-политикой закрывают запуск.
 */
export function assertCodexWorkspaceProfile(
  opened: unknown,
  config: unknown,
  id: string,
  expected: Record<string, JsonValue>,
): void {
  const active = isRecord(opened) && isRecord(opened.activePermissionProfile)
    ? opened.activePermissionProfile : null;
  const settings = isRecord(config) && isRecord(config.config) ? config.config : null;
  const profile = isRecord(settings?.permissions) ? settings.permissions[id] : null;
  const filesystem = isRecord(profile) && isRecord(profile.filesystem)
    ? Object.fromEntries(Object.entries(profile.filesystem).filter(([, value]) => value !== null)) : null;
  const entries = (value: unknown) => isRecord(value) ? Object.entries(value).sort() : [];

  if (active?.id !== id || active.extends != null || !isRecord(profile)
      || profile.extends != null || profile.workspace_roots != null
      || !isRecord(profile.network) || profile.network.enabled !== false
      || JSON.stringify(entries(filesystem)) !== JSON.stringify(entries(expected.filesystem))) {
    throw new Error('Codex не подтвердил изолированный профиль файлов триажа.');
  }
}
