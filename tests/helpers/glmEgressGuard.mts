import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Плагин запрета внешнего fetch для подмены адреса модели (Р16): только loopback.
 * Пишется рядом со стендом и передаётся launcher-у как egressGuard.
 */
export async function writeGlmEgressGuard(root: string): Promise<string> {
  const guard = path.join(root, 'glm-egress-guard.mjs');

  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(guard, [
    'export const name = "grigdesk-glm-egress-guard";',
    'export function apply() {',
    '  const original = globalThis.fetch;',
    '  globalThis.fetch = (input, ...args) => {',
    '    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));',
    '    if (url.hostname !== "127.0.0.1") {',
    '      throw new Error("Стенд GLM допускает только loopback fetch");',
    '    }',
    '    return original(input, ...args);',
    '  };',
    '}',
  ].join('\n') + '\n', { mode: 0o600 });

  return guard;
}
