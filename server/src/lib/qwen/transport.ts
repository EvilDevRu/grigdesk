import { createAcpClient } from '../acp/client.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';
import { redactRunnerError } from '../factoryProviderRunner.ts';
import { startQwenSandbox } from './sandbox.ts';
import type { QwenSnapshot } from './settings.ts';

export const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

const ACTIVE_WORK_KEY = 'qwen.daemon.activeWorkHeartbeat';
const ACTIVE_WORK_CATEGORIES = ['agent', 'notification', 'shell', 'session', 'workflow', 'tool'];

/**
 * Один reader обслуживает handshake, reverse RPC и шаги; парсер ACP не дублируется.
 * Без подтверждённого private guard процесс завершается до пользовательского prompt.
 */
export async function openQwenTransport(
  config: unknown,
  snapshot: QwenSnapshot,
  options: Parameters<typeof startQwenSandbox>[2],
  handlers: Parameters<typeof createAcpClient>[1] = {},
) {
  const sandbox = await startQwenSandbox(config, snapshot, options);

  const client = createAcpClient(sandbox.child, { requestTimeoutMs: 30000, ...handlers });

  try {
    const initialized = record(await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'GrigDesk', version: '1' },
      _meta: {
        'qwen-code/private-parent-capability': sandbox.nonce,
        ...(options.hostAccess ? {
          [ACTIVE_WORK_KEY]: {
            v: 1,
            intervalMs: 5000,
            categories: ACTIVE_WORK_CATEGORIES,
          },
        } : {}),
      },
    }, 15000));

    if (initialized.protocolVersion !== 1
      || record(initialized._meta)['qwen-code/external-tool-guard-ready'] !== 'required-v1') {
      throw new Error('Qwen: несовместимый протокол обязательного guard');
    }

    const heartbeat = record(record(initialized._meta)[ACTIVE_WORK_KEY]);

    if (options.hostAccess && (heartbeat.v !== 1 || !Array.isArray(heartbeat.categories)
      || !ACTIVE_WORK_CATEGORIES.every((category) => (heartbeat.categories as unknown[]).includes(category))
      || typeof heartbeat.intervalMs !== 'number'
      || heartbeat.intervalMs < 5000 || heartbeat.intervalMs > 60000)) {
      throw new Error('Qwen: несовместимый active-work heartbeat');
    }

    return {
      client,
      child: sandbox.child,
      images: record(record(initialized.agentCapabilities).promptCapabilities).image === true,
      stderr: sandbox.stderr,
      async close() {
        client.close();
        await sandbox.close();
      },
    };
  } catch (error) {
    client.close();

    if (!options.onOwnedProcess) {
      await sandbox.close();
    }

    const reason = `${String((error as Error).message)} ${sandbox.stderr()}`.trim();

    throw new Error(redactRunnerError(reason, snapshot.envKeys.map((key) => process.env[key])));
  }
}
