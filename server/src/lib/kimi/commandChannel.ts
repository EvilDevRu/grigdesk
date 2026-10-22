import { createWorkIpc } from '../executors/workIpc.ts';
import { createKimiCommandTool } from './commandTool.ts';
import { COMMAND_MCP } from './commandProfile.ts';

/**
 * Канал живёт только внутри одного хода и использует существующий work MCP.
 * Сначала отменяются команды, затем закрывается приватный IPC без активных ответов.
 */
export async function createKimiCommandChannel(
  options: Parameters<typeof createKimiCommandTool>[0],
) {
  const workTools = createKimiCommandTool(options);

  try {
    const ipc = await createWorkIpc({ workTools });

    return {
      socketPath: ipc.socketPath,
      nonce: ipc.nonce,
      mcpServer: {
        name: COMMAND_MCP,
        command: ipc.mcpServer.command,
        args: ipc.mcpServer.args,
        toolTimeoutMs: 2_147_483_647,
      },
      async close(): Promise<void> {
        await workTools.close();
        await ipc.close();
      },
    };
  } catch (error) {
    await workTools.close();

    throw error;
  }
}
