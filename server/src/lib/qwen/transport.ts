import { createAcpClient } from '../acp/client.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';
import { redactRunnerError } from '../factoryProviderRunner.ts';
import { startQwenSandbox } from './sandbox.ts';
import { QWEN_PREVIEW_VERSION } from './previewRelease.ts';
import type { QwenSnapshot } from './settings.ts';

export const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

/**
 * Один reader обслуживает handshake, reverse RPC и шаги Preview.2.
 * До handshake песочница уже закрепила ELF и управляемые правила разрешений.
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
    }, 15000));

    if (initialized.protocolVersion !== 1
      || record(initialized.agentInfo).version !== QWEN_PREVIEW_VERSION) {
      throw new Error('Qwen: несовместимый протокол ACP Preview.2');
    }

    return {
      client,
      child: sandbox.child,
      images: record(record(initialized.agentCapabilities).promptCapabilities).image === true,
      stderr: sandbox.stderr,
      workMcpUnavailable: sandbox.workMcpUnavailable,
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
