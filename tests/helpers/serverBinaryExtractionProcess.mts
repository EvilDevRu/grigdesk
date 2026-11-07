import { readFile } from 'node:fs/promises';

import { materializePayload } from '../../server/src/binary/cache.ts';
import type { PayloadDescriptor } from '../../deepseek/src/runtime/payloadIndex.ts';

interface StartMessage {
  kind: 'start';
  cacheDir: string;
  packageId: string;
  payload: PayloadDescriptor;
  archiveFile: string;
  hold: boolean;
}

/**
 * IPC-барьер останавливает собственный процесс после появления staging и lock.
 * Родитель может проверить конкуренцию или послать SIGKILL без гонки с готовым результатом.
 */
async function run(message: StartMessage): Promise<void> {
  try {
    process.send?.({ kind: 'started' });

    const directory = await materializePayload({
      cacheDir: message.cacheDir,
      packageId: message.packageId,
      payload: message.payload,
      lockOptions: { waitMs: 5000 },
      archive: async function* () {
        const bytes = await readFile(message.archiveFile);

        process.send?.({ kind: 'archive-opened' });
        yield bytes.subarray(0, 100);

        if (message.hold) {
          process.send?.({ kind: 'staging' });
          await new Promise<void>((resolve) => process.once('message', () => resolve()));
        }

        yield bytes.subarray(100);
      },
    });

    process.send?.({ kind: 'done', directory });
  } catch (error) {
    process.send?.({
      kind: 'failed',
      code: (error as { code?: string }).code,
      message: String(error),
    });
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
}

process.once('message', (message: StartMessage) => void run(message));
process.send?.({ kind: 'ready' });
