import { createAcpClient } from '../acp/client.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';
import { redactRunnerError } from '../factoryProviderRunner.ts';
import { startQwenSandbox } from './sandbox.ts';
import type { QwenSnapshot } from './settings.ts';

export const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

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
      _meta: { 'qwen-code/private-parent-capability': sandbox.nonce },
    }, 15000));

    if (initialized.protocolVersion !== 1
      || record(initialized._meta)['qwen-code/external-tool-guard-ready'] !== 'required-v1') {
      throw new Error('Qwen: несовместимый протокол обязательного guard');
    }

    return {
      client,
      images: record(record(initialized.agentCapabilities).promptCapabilities).image === true,
      stderr: sandbox.stderr,
      async close() {
        client.close();
        await sandbox.close();
      },
    };
  } catch (error) {
    client.close();
    await sandbox.close();

    const reason = `${String((error as Error).message)} ${sandbox.stderr()}`.trim();

    throw new Error(redactRunnerError(reason, snapshot.envKeys.map((key) => process.env[key])));
  }
}
