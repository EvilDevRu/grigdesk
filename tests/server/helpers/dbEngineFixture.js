import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

export const SPI = ['open', 'close', 'schema', 'analyze', 'inspectRights', 'estimate', 'execute', 'cancel'];

/**
 * Внешний пакет имеет ровно контракт драйвера и собственный временный root.
 * Entry не импортируется помощником: marker обнаруживает преждевременное исполнение.
 */
export async function engineTree(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-db-driver-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * Manifest и entry создаются непосредственно в переданном root фикстуры.
 * Отсутствие version намеренно проверяет получение версии из Git-тега.
 */
export async function writeEngine(root, id = 'fixture-db', overrides = {}, source = adapterSource(id)) {
  const dir = path.join(root, id);

  await mkdir(dir, { recursive: true });

  await writeFile(path.join(dir, 'engine.json'), JSON.stringify({
    id,
    label: 'Внешняя СУБД',
    kind: 'db-engine',
    api: 1,
    minimum: '0.0.0',
    entry: 'entry.mjs',
    ...overrides,
  }));

  await writeFile(path.join(dir, 'entry.mjs'), source);

  return dir;
}

/**
 * Все восемь методов принадлежат адаптеру с произвольным именем СУБД.
 * Управляемый запрос позволяет проверить настоящую отмену и очистку аудита.
 */
export function adapterSource(id = 'fixture-db', prefix = '') {
  return `${prefix}
    const calls = [];
    let finish;
    export default {
      id: ${JSON.stringify(id)},
      label: 'Внешняя СУБД',
      capabilities: { schema: true, readOnly: true },
      calls,
      async open({ password, stream, openStream }) {
        calls.push(['open', Buffer.isBuffer(password), Boolean(stream), typeof openStream]);
        if (openStream) await openStream();
        return { readOnlyActive: true };
      },
      async close() { calls.push(['close']); },
      async schema() { calls.push(['schema']); return { tables: [] }; },
      async analyze() {
        calls.push(['analyze']);
        return { queryClass: 'read', single: true, tables: [], forbidden: [], tableFunctions: [] };
      },
      async inspectRights() {
        calls.push(['inspectRights']);
        return { confirmedReadOnly: true, writable: false };
      },
      async estimate() { calls.push(['estimate']); return { rows: 1, bytes: 32, timeoutMs: 20 }; },
      async execute(_handle, request) {
        calls.push(['execute', request.limits]);
        if (request.text === 'WAIT') return new Promise((resolve) => { finish = resolve; });
        return [{ answer: 42 }];
      },
      async cancel() {
        calls.push(['cancel']);
        finish?.([{ late: true }]);
        return { ok: true, method: 'query' };
      },
    };
  `;
}
