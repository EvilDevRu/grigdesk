import { spawn } from 'node:child_process';

import { createAcpClient } from '../acp/client.ts';
import { createWorkIpc } from '../executors/workIpc.ts';
import { factoryStatusEnvironment } from '../factoryProviderRunner.ts';
import { helperCommand } from '../runtimePaths.ts';
import { record } from './transport.ts';

/**
 * Статусный helper работает на хосте с выданной движком identity.
 * Модель получает только приватный IPC: control-root и ключи API ей не выдаются.
 */
export async function createQwenFactoryStatus(root: string, env: NodeJS.ProcessEnv) {
  const command = helperCommand('factory-status-mcp', []);
  const statusEnv = Object.fromEntries(factoryStatusEnvironment(env).map(({ name, value }) => [name, value]));
  const child = spawn(command.command, command.args, {
    env: {
      PATH: env.PATH,
      LANG: env.LANG,
      ...statusEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  const client = createAcpClient(child, { requestTimeoutMs: 30000 });

  // stderr helper-а не становится потоком API-секретов и не блокирует pipe.
  child.stderr.resume();

  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'GrigDesk', version: '1' },
    });
    client.notify('notifications/initialized', {});

    const tools = record(await client.request('tools/list', {}));
    const ipc = await createWorkIpc({
      root,
      workTools: {
        descriptors: tools.tools,
        async invoke(name, input) {
          const result = record(await client.request('tools/call', { name, arguments: input }));

          if (result.isError) {
            throw new Error('Qwen: статусный MCP отклонил запрос');
          }

          return result;
        },
      },
    });

    return {
      mcpServer: { name: 'factory-status', ...ipc.mcpServer },
      /**
       * IPC закрывается после остановки Qwen, затем завершается только свой helper.
       * Статусный процесс не переживает завершившийся или отменённый ход.
       */
      async close() {
        await ipc.close();
        client.close();
        child.stdin.end();
        child.kill('SIGTERM');
        await closed;
      },
    };
  } catch (error) {
    client.close();
    child.kill('SIGKILL');
    await closed;

    throw error;
  }
}
