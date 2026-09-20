export * from '../acp/client.ts';

import type { AcpClient } from '../acp/client.ts';
import { initializeAcp } from '../acp/client.ts';

/** Совместимое имя Kimi остаётся на старом import path. */
export function initializeKimiAcp(client: AcpClient): Promise<unknown> {
  return initializeAcp(client, 15_000);
}
