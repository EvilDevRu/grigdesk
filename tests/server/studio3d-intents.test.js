import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLibrary } from '../../server/src/lib/studio3d/library.ts';
import { canonicalJson, createIntents, requestFingerprint } from '../../server/src/lib/studio3d/intents.ts';

const id = '00000000-0000-4000-8000-000000000001';

/**
 * Журнал существует только в тестовой библиотеке, owner удерживается реально.
 * Повторное открытие читает тот же fsync JSON, без внешних услуг и состояния.
 */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-studio-intents-'));
  const library = createLibrary({ dir });

  await library.ensure();
  t.after(async () => {
    await library.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  return {
    dir,
    library,
    intents: createIntents({ library })
  };
}

/**
 * Начальная запись содержит полный исходный запрос и не имеет credentials.
 * Дочерние позиции добавляет jobs до первого платного send.
 */
function record(libraryId) {
  const request = {
    libraryId,
    idempotencyKey: id,
    provider: 'fixture',
    operation: 'text-to-model',
    values: { prompt: 'Первый запрос' },
    expectedPrice: 30
  };

  return {
    schema: 1,
    kind: 'run',
    intentId: id,
    libraryId,
    request,
    requestFingerprint: requestFingerprint(request),
    executionFingerprint: 'fixture-execution',
    accountKey: 'fixture-account',
    provider: 'fixture',
    operation: 'text-to-model',
    values: request.values,
    confirmedPrice: 30,
    unit: null,
    catalogVersion: 'fixture-v2',
    context: {
      kind: null,
      format: null,
      stats: null,
      params: null,
      nativeTaskType: null,
      rigCheck: null,
      views: []
    },
    model: null,
    modelId: null,
    parentVersionId: null,
    inputs: [],
    children: [],
    projectionReady: false,
    preparation: 'pending',
    batch: null,
    batchParent: null,
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:00Z',
    revision: 0,
  };
}

test('IN-01 канонический JSON сортирует ключи, сохраняет порядок/пробелы значений, отвергает NaN', () => {
  assert.equal(canonicalJson({ b: [2, 1], a: ' x ' }), '{"a":" x ","b":[2,1]}');
  assert.equal(requestFingerprint({ b: 2, a: 1 }), requestFingerprint({ a: 1, b: 2 }));
  assert.notEqual(requestFingerprint({ a: ' x ' }), requestFingerprint({ a: 'x' }));
  assert.throws(() => canonicalJson({ a: NaN }));
});

test('IN-08 nested контекст и значения проверяются до durable reserve', async (t) => {
  const { library, intents } = await fixture(t);

  for (const edit of [
    (source) => {
      source.context.kind = 'неизвестный';
    },
    (source) => {
      source.context.views = ['front', 'front'];
    },
    (source) => {
      source.values = { nested: { file: '/outside' } };
    },
    (source) => {
      source.unit = {
        one: 'кредит',
        few: 'кредита',
        many: 'кредитов',
        extra: true
      };
    },
  ]) {
    const source = record(library.libraryId);

    edit(source);
    await assert.rejects(intents.reserve(source), (error) => error.code === 'invalid_intent');
  }

  assert.equal((await intents.list()).length, 0);
});

test('IN-02 двадцать reserve одного UUID дают одну durable запись и replay', async (t) => {
  const { library, intents } = await fixture(t);
  const source = record(library.libraryId);
  const results = await Promise.all(Array.from({ length: 20 }, () => intents.reserve(source)));

  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal((await intents.list()).length, 1);

  const fresh = createIntents({ library });

  await fresh.load();
  assert.equal((await fresh.get(id)).requestFingerprint, source.requestFingerprint);
  assert.equal((await fresh.reserve(source)).created, false);
});

test('IN-03 конфликт payload и libraryId проверяется до изменения журнала', async (t) => {
  const { library, intents } = await fixture(t);
  const source = record(library.libraryId);

  await intents.reserve(source);
  await assert.rejects(intents.reserve({
    ...source,
    request: { ...source.request, values: { prompt: 'Другая цена' } },
    requestFingerprint: requestFingerprint({ ...source.request, values: { prompt: 'Другая цена' } })
  }), (error) => error.code === 'idempotency_conflict');
  await assert.rejects(intents.get(id, '00000000-0000-4000-8000-000000000002'),
    (error) => error.code === 'stale_library');
  assert.equal((await intents.get(id)).request.values.prompt, 'Первый запрос');
});

test('IN-04 update сериализуется, ENOSPC не меняет durable snapshot, unknown не исчезает', async (t) => {
  const { library, intents } = await fixture(t);

  await intents.reserve(record(library.libraryId));
  await Promise.all(Array.from({ length: 20 }, () => intents.update(id, (current) => {
    current.revision += 1;
  })));

  const current = await intents.get(id);

  assert.equal(current.revision >= 20, true);

  const failed = createIntents({ library, beforeWrite: async () => {
    throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
  } });

  await failed.load();
  await assert.rejects(failed.update(id, (item) => {
    item.preparation = 'complete';
  }), (error) => error.code === 'ENOSPC');
  assert.equal((await intents.get(id)).preparation, 'pending');
});

test('IN-05 schema/traversal/symlink журнала отклоняются до чтения произвольного JSON', async (t) => {
  const { dir, library, intents } = await fixture(t);

  await assert.rejects(intents.get('../settings'));
  await intents.reserve(record(library.libraryId));

  const file = path.join(dir, '.jobs', id, 'intent.json');

  await fs.writeFile(file, JSON.stringify({ schema: 99, intentId: id }));
  await assert.rejects(createIntents({ library }).load(), (error) => error.code === 'invalid_intent');
  await fs.unlink(file);
  await fs.symlink(path.join(dir, '.library.json'), file);
  await assert.rejects(createIntents({ library }).load());
});

test('IN-06 concurrent initial load разных UUID не стирает соседние durable записи из cache', async (t) => {
  const { library, intents } = await fixture(t);
  const sources = Array.from({ length: 20 }, (_, index) => {
    const intentId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const source = record(library.libraryId);

    source.intentId = intentId;
    source.request.idempotencyKey = intentId;
    source.requestFingerprint = requestFingerprint(source.request);

    return source;
  });

  await Promise.all(sources.map((source) => intents.reserve(source)));
  assert.equal((await intents.list()).length, 20);

  const fresh = createIntents({ library });

  await fresh.load();
  assert.equal((await fresh.list()).length, 20);
});

test('IN-07 медленный второй initial load не откатывает cache после первого fsync', async (t) => {
  const { library, intents } = await fixture(t);

  await intents.reserve(record(library.libraryId));

  let release;
  let reads = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fresh = createIntents({
    library,
    beforeRead: async () => {
      reads += 1;

      if (reads === 2) {
        await gate;
      }
    },
    afterWrite: async () => release()
  });
  const sources = [2, 3].map((index) => {
    const source = record(library.libraryId);

    source.intentId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    source.request.idempotencyKey = source.intentId;
    source.requestFingerprint = requestFingerprint(source.request);

    return source;
  });

  await Promise.all(sources.map((source) => fresh.reserve(source)));
  assert.equal((await fresh.list()).length, 3);
});
