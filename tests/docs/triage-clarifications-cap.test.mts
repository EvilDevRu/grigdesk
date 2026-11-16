// Уточнения человека читают двое — триаж (промпт) и конвейер (вклейка в тикет). Предел
// у них обязан быть один: разный объём у двух читателей — это две разные постановки одной
// задачи, а обрезанный хвост — потерянный ответ человека, причём самый свежий.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { CAP_CLARIFICATIONS } from '../../server/src/lib/analysis/prompt.ts';

const ROOT = new URL('../../', import.meta.url);

test('вклейка уточнений в тикет режется общим пределом, а не своим литералом', async () => {
  const factory = await readFile(new URL('server/src/modules/factory/index.ts', ROOT), 'utf8');

  assert.deepEqual({
    shared: /clarify\.slice\(0,\s*CAP_CLARIFICATIONS\)/u.test(factory),
    literal: /clarify\.slice\(0,\s*\d+\)/u.test(factory),
  }, { shared: true, literal: false });
});

test('контракт триажа называет тот же предел уточнений, что и код', async () => {
  const doc = await readFile(new URL('docs/grigdesk/guide/ru/tasks.md', ROOT), 'utf8');
  const stated = CAP_CLARIFICATIONS.toLocaleString('ru-RU').replace(/ /gu, ' ');

  assert.match(doc, new RegExp(`Уточнения человека[^\\n]*\\| ${stated} символов`, 'u'));
});
