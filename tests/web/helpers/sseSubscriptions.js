import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { WEB_SSE_SIGNALS } from '../../../shared/web-log/webDiagnostics.ts';

/**
 * Список событий принадлежит общему контракту, а useSse обязан подписываться на него.
 * Проверка проводки сохраняет сторож молча пропущенных именованных событий после выноса массива.
 */
export async function subscribedSseNames() {
  const source = await readFile(new URL('../../../web/src/composables/useSse.ts', import.meta.url), 'utf8');

  assert.match(source, /const EVENT_NAMES\s*(?::[^=]+)?=\s*WEB_SSE_SIGNALS\s*;/u);
  assert.match(source, /for\s*\(const name of EVENT_NAMES\)/u);

  return new Set(WEB_SSE_SIGNALS);
}
