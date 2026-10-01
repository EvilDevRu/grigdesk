// Дом серверного Kimi в host-режиме: сохраняет пользовательские настройки и сессии,
// добавляет только служебные MCP текущего хода, не переписывая home человека.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface McpSpec {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Временный home хранит собственный server.token и объединённый mcp.json.
 * Остальные записи top-level ссылаются на исходный home: transcript и binding живут там же.
 */
export async function buildKimiHostWebHome(input: {
  kimiHome: string;
  runtimeHome: string;
  mcpServers: readonly McpSpec[];
  isolateConfig?: boolean;
}): Promise<{ home: string; cleanup(): Promise<void> }> {
  const home = path.join(input.runtimeHome, 'host-web', randomUUID());

  await fs.mkdir(home, { recursive: true, mode: 0o700 });

  try {
    const entries = await fs.readdir(input.kimiHome, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === 'mcp.json' || entry.name === 'server.token') {
        continue;
      }

      if (entry.name === 'config.toml' && input.isolateConfig) {
        if ((await fs.stat(path.join(input.kimiHome, entry.name))).size > 2_097_152) {
          throw new Error('Конфигурация Kimi превышает предел объёма');
        }

        await fs.copyFile(path.join(input.kimiHome, entry.name), path.join(home, entry.name));
        await fs.chmod(path.join(home, entry.name), 0o600);
        continue;
      }

      await fs.symlink(
        path.join(input.kimiHome, entry.name),
        path.join(home, entry.name),
        entry.isDirectory() ? 'dir' : 'file',
      );
    }

    let source: Record<string, unknown> = {};

    try {
      source = JSON.parse(await fs.readFile(path.join(input.kimiHome, 'mcp.json'), 'utf8'));
    } catch (error) {
      if ((error as { code?: string })?.code !== 'ENOENT') {
        throw new Error('Kimi host mcp.json не удалось разобрать для серверного запуска.');
      }
    }

    const configured = source.mcpServers;

    if (configured !== undefined && (
      !configured || typeof configured !== 'object' || Array.isArray(configured)
    )) {
      throw new Error('Kimi host mcp.json содержит некорректный mcpServers.');
    }

    const merged = { ...(configured as Record<string, unknown> || {}) };

    for (const server of input.mcpServers) {
      if (!server.name || !server.command) {
        continue;
      }

      merged[server.name] = {
        command: server.command,
        args: Array.isArray(server.args) ? server.args : [],
        ...(server.env ? { env: server.env } : {}),
      };
    }

    await fs.writeFile(path.join(home, 'mcp.json'), JSON.stringify({
      ...source,
      mcpServers: merged,
    }), { mode: 0o600 });

    return {
      home,
      cleanup: () => fs.rm(home, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(home, { recursive: true, force: true });

    throw error;
  }
}
