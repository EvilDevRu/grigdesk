import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { createScopedWorkspaceTools } from '../executors/scopedWorkspace.ts';
import { createWorkIpc } from '../executors/workIpc.ts';
import type { WorkToolsPort } from '../executors/workIpc.ts';
import { buildContainedKimiConfig, KIMI_MODELS } from './profile.ts';
import { assertPrivateCredentialDir } from './sandbox.ts';
import { buildKimiRuntimeEnv } from './env.ts';
import { runKimiServerTurn } from './serverTurn.ts';
import type { KimiServerTurnOptions } from './serverTurn.ts';
import type { KimiServerClient } from './serverClient.ts';

type ScopedKimiOptions = Pick<KimiServerTurnOptions,
  'cwd' | 'message' | 'model' | 'effort' | 'signal' | 'onStep' | 'onProgress' | 'onRunMetadata'> & {
  config: { kimiBin: string; kimiHome: string };
  env?: NodeJS.ProcessEnv;
  workspaceAccess: unknown;
  workTools?: WorkToolsPort | null;
  startServer?: KimiServerTurnOptions['startServer'];
};

/**
 * Проверяем эффективный каталог сессии, а не только сгенерированный tools.enabled.
 * Поздняя готовность своего MCP ожидается ограниченно; любой активный чужой инструмент запрещён.
 */
async function verifyTools(
  client: KimiServerClient,
  sessionId: string,
  expected: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    signal?.throwIfAborted();

    const response = await client.tools(sessionId);

    if (!Array.isArray(response.tools)) {
      throw new Error('Kimi не подтвердил инструменты триажа.');
    }

    const active = response.tools.filter((tool) => isRecord(tool) && tool.active !== false);

    if (active.some((tool) => !expected.has(String(tool.name)))) {
      throw new Error('Kimi оставил доступным инструмент вне области триажа.');
    }
    if (active.length === expected.size
      && [...expected].every((name) => active.some((tool) => tool.name === name))) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('Файловые инструменты триажа Kimi не подготовлены.');
}

/**
 * Одноразовый home наследует только авторизацию CLI, без чатов, навыков, MCP и пользовательского config.
 * Модель получает только собственные файловые операции; исходники остаются за серверным брокером.
 */
export async function runScopedKimi(options: ScopedKimiOptions) {
  const model = KIMI_MODELS.find((entry) => entry.id === options.model);

  if (!model || options.effort && !(model.efforts as readonly string[]).includes(options.effort)) {
    throw new Error('Модель или усилие триажа Kimi отсутствуют в каталоге.');
  }

  await assertPrivateCredentialDir(options.config.kimiHome);

  const tools = await createScopedWorkspaceTools(options.workspaceAccess, options.workTools, options.signal);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-triage-kimi-'));
  let ipc: Awaited<ReturnType<typeof createWorkIpc>> | undefined;

  try {
    ipc = await createWorkIpc({ workTools: tools, root: directory });

    const names = tools.descriptors.map((tool) => `mcp__grigdesk-work__${tool.name}`);
    const config = buildContainedKimiConfig() + '\n[tools]\n'
      + `enabled = ${JSON.stringify(names)}\n`;

    await Promise.all([
      fs.symlink(path.join(options.config.kimiHome, 'credentials'),
        path.join(directory, 'credentials'), 'dir'),
      fs.writeFile(path.join(directory, 'config.toml'), config, { mode: 0o600 }),
      fs.writeFile(path.join(directory, 'mcp.json'), JSON.stringify({ mcpServers: {
        'grigdesk-work': { command: ipc.mcpServer.command, args: ipc.mcpServer.args },
      } }), { mode: 0o600 }),
    ]);

    return await runKimiServerTurn({
      ...options,
      bin: options.config.kimiBin,
      home: directory,
      sessionId: null,
      permissionMode: 'yolo',
      env: {
        ...buildKimiRuntimeEnv(),
        HOME: directory,
        KIMI_CODE_HOME: directory,
        KIMI_CODE_CACHE_DIR: path.join(directory, 'cache'),
        KIMI_CODE_NO_AUTO_UPDATE: '1',
        XDG_CONFIG_HOME: path.join(directory, '.config'),
        XDG_CACHE_HOME: path.join(directory, '.cache'),
        XDG_DATA_HOME: path.join(directory, '.local', 'share'),
        TMPDIR: directory,
        PATH: options.env?.PATH || process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      },
      verifyTools: (client, sessionId) => verifyTools(client, sessionId, new Set(names), options.signal),
      onApproval: async (_approval, respond) => {
        await respond({ decision: 'denied' });
      },
      onQuestion: async (_question, respond) => {
        await respond({ answers: {}, method: 'cancelled' });
      },
    });
  } finally {
    await ipc?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
