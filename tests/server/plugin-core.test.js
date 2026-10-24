import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { getProviderAdapters } from '../../server/src/lib/executors/index.ts';
import { withPathLock } from '../../server/src/lib/pathLock.ts';
import { acquireKernelFileLock } from '../../server/src/lib/kernelLock.ts';
import { parseByteRange } from '../../server/src/lib/httpRange.ts';
import { DocumentReader } from '../../server/src/lib/documents/reader.ts';
import { pluginCore, runtimeFixture, settle } from './helpers/pluginRuntimeFixture.js';

/**
 * Подменяем только содержимое штатного Map в процессе данного тестового файла.
 * Синтетические исполнители не читают ключи и не обращаются к CLI или внешней сети.
 */
async function providersFixture(t) {
  const adapters = await getProviderAdapters();
  const saved = new Map(adapters);
  const calls = [];
  const snapshot = {
    accountKey: 'account',
    billingUrl: 'https://example.test',
    credentials: 'SECRET',
  };
  const capability = {
    id: 'synthetic',
    name: 'Синтетический',
    local: false,
    unit: {
      one: 'кредит',
      few: 'кредита',
      many: 'кредитов',
    },
    usdPerUnit: 1,
    available() {
      assert.equal(this, capability);

      return true;
    },
    operations: () => [],
    validate: () => ({ ok: true }),
    quote: () => ({ total: 0 }),
    snapshot: () => snapshot,
  };

  for (const [method, position] of [
    ['isCurrent', 0], ['balance', 0], ['history', 0],
    ['prepare', 1], ['send', 1], ['poll', 1],
  ]) {
    capability[method] = function (...args) {
      assert.equal(this, capability);
      calls.push({
        method,
        snapshot: args[position],
        args,
      });

      return method === 'isCurrent' ? true : Promise.resolve([]);
    };
  }

  adapters.clear();
  adapters.set('synthetic', {
    id: 'synthetic',
    type: '3d',
    studio3d: capability,
    credentials: 'ADAPTER_SECRET',
    probe: () => {},
    auth: () => {},
    login: () => {},
    run: () => {},
  });
  adapters.set('universal', {
    id: 'universal',
    type: 'universal',
    studio3d: capability,
  });
  adapters.set('empty', { id: 'empty', type: '3d' });
  t.after(() => {
    adapters.clear();

    for (const [id, adapter] of saved) {
      adapters.set(id, adapter);
    }
  });

  return {
    adapters,
    capability,
    snapshot,
    calls,
  };
}

test('CORE-01: server.js получает полный набор ядра', async (t) => {
  const f = await runtimeFixture(t);
  const core = pluginCore(f);

  for (const method of ['getProviders', 'emit', 'withPathLock', 'acquireKernelFileLock', 'parseByteRange']) {
    assert.equal(typeof core[method], 'function', method);
  }

  for (const method of ['roots', 'resolveAbsolute', 'read', 'readAsset']) {
    assert.equal(typeof core.documents[method], 'function', method);
  }

  assert.equal(core.documents.addRootProvider, undefined);
  assert.equal(core.documents.addScopeProvider, undefined);
  await assert.rejects(async () => core.documents.roots(), /доступ|reader|чтени/i);
});

test('CORE-02: только capability типа 3d, без полей входа и запуска адаптера', async (t) => {
  const provider = await providersFixture(t);
  const f = await runtimeFixture(t);
  const core = pluginCore(f);
  const list = await core.getProviders('3d');

  assert.deepEqual(list.map((item) => item.id), ['synthetic']);
  assert.equal(await list[0].available(), true);
  assert.equal(Object.isFrozen(list[0]), true);
  assert.notEqual(list[0], provider.capability);

  for (const key of ['probe', 'auth', 'login', 'credentials', 'run', 'studio3d']) {
    assert.equal(list[0][key], undefined, key);
  }

  for (const type of ['universal', 'chat', '3D', '', null]) {
    assert.deepEqual(await core.getProviders(type), []);
  }

  provider.adapters.delete('synthetic');
  assert.deepEqual(await core.getProviders('3d'), [], 'каждый вызов читает штатный реестр');
});

test('CORE-03: непрозрачный snapshot, привязка this и исходные аргументы всех методов', async (t) => {
  const raw = await providersFixture(t);
  const f = await runtimeFixture(t, [{ id: 'demo' }, { id: 'other' }]);
  const core = pluginCore(f);
  const [provider] = await core.getProviders('3d');
  const snapshot = provider.snapshot();

  assert.deepEqual(snapshot, { accountKey: raw.snapshot.accountKey, billingUrl: raw.snapshot.billingUrl });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false);

  const [again] = await core.getProviders('3d');
  const [foreign] = await pluginCore(f, 'other').getProviders('3d');

  for (const [method, args] of [
    ['isCurrent', [snapshot]], ['balance', [snapshot]], ['history', [snapshot]],
    ['prepare', [{ childId: 'task' }, snapshot]], ['send', [{ childId: 'task' }, snapshot]],
    ['poll', [['task'], snapshot]],
  ]) {
    await again[method](...args);
    assert.equal(raw.calls.at(-1).snapshot, raw.snapshot, method);

    for (const invalid of [{ ...snapshot }, JSON.parse(JSON.stringify(snapshot)), foreign.snapshot()]) {
      const invalidArgs = [...args];
      const before = raw.calls.length;

      invalidArgs[method === 'prepare' || method === 'send' || method === 'poll' ? 1 : 0] = invalid;
      await assert.rejects(async () => provider[method](...invalidArgs), TypeError);
      assert.equal(raw.calls.length, before, 'чужой снимок не дошёл до исполнителя');
    }
  }

  raw.adapters.set('second', {
    type: '3d',
    studio3d: { ...raw.capability, id: 'second' },
  });

  const second = (await core.getProviders('3d')).find((item) => item.id === 'second');

  await assert.rejects(async () => second.isCurrent(snapshot), TypeError);

  for (const method of ['balance', 'history', 'poll']) {
    await provider[method](...(method === 'poll' ? [[], undefined] : [undefined]));
    assert.equal(raw.calls.at(-1).snapshot, undefined);
  }
});

test('CORE-04: плагин конкурирует с ядром за ту же очередь и kernel flock', async (t) => {
  const f = await runtimeFixture(t);
  const core = pluginCore(f);
  const held = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const order = [];
  const key = path.join(f.root, 'shared-key');
  const first = withPathLock(key, async () => {
    entered.resolve();
    await held.promise;
    order.push('kernel');
  });

  await entered.promise;

  const second = core.withPathLock(key, async () => order.push('plugin'));

  try {
    await settle();
    assert.deepEqual(order, []);
  } finally {
    held.resolve();
    await Promise.all([first, second]);
  }

  assert.deepEqual(order, ['kernel', 'plugin']);

  const lockPath = path.join(f.root, 'kernel.lock');
  const lock = await acquireKernelFileLock({ lockPath });

  try {
    await assert.rejects(core.acquireKernelFileLock({ lockPath, timeoutMs: 10 }), {
      code: 'FILE_LOCK_TIMEOUT',
    });
  } finally {
    await lock.release();
  }

  const pluginLock = await core.acquireKernelFileLock({ lockPath });

  try {
    await assert.rejects(acquireKernelFileLock({ lockPath, timeoutMs: 10 }), { code: 'FILE_LOCK_TIMEOUT' });
  } finally {
    await pluginLock.release();
  }

  await (await acquireKernelFileLock({ lockPath })).release();
});

test('CORE-05: тот же живой reader, запрет выхода и штатный Range', async (t) => {
  const reader = new DocumentReader();
  const f = await runtimeFixture(t, [{ id: 'demo' }], { documentReader: reader });
  const core = pluginCore(f);
  const root = path.join(f.root, 'docs');

  await mkdir(root);
  await writeFile(path.join(root, 'hello.md'), 'Документ');
  await writeFile(path.join(root, 'asset.png'), Buffer.from([137, 80, 78, 71]));
  await writeFile(path.join(f.root, 'outside.md'), 'Чужое');
  reader.addRootProvider(() => [{
    id: 'fixture',
    label: 'Документы',
    path: root,
  }]);
  assert.deepEqual(await core.documents.roots(), await reader.roots());

  const resolved = await core.documents.resolveAbsolute(path.join(root, 'hello.md'));

  assert.equal((await core.documents.read(resolved.ref)).content, 'Документ');
  assert.deepEqual((await core.documents.readAsset({ source: 'fixture', path: 'asset.png' })).content,
    Buffer.from([137, 80, 78, 71]));
  await assert.rejects(core.documents.resolveAbsolute(path.join(f.root, 'outside.md')), {
    code: 'document_outside_roots',
  });
  await assert.rejects(core.documents.read({ source: 'fixture', path: '../outside.md' }), {
    code: 'document_outside_roots',
  });
  await assert.rejects(core.documents.readAsset({ source: 'fixture', path: '../outside.png' }), {
    code: 'document_outside_roots',
  });

  for (const header of ['bytes=1-3', 'bytes=-4', 'bytes=5-', 'bytes=90-', 'bytes=4-2', 'garbage', null]) {
    assert.deepEqual(core.parseByteRange(header, 10), parseByteRange(header, 10));
  }
});

/**
 * Читает настоящие SSE-фреймы с ограничением времени и освобождает свой таймер.
 * JSON декодируется после выделения фрейма: управляющие символы данных не становятся событиями.
 */
async function nextFrame(reader, state) {
  while (!state.buffer.includes('\n\n')) {
    let timer;
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Нет SSE-фрейма')), 2000);
      }),
    ]).finally(() => clearTimeout(timer));

    assert.equal(chunk.done, false);
    state.buffer += new TextDecoder().decode(chunk.value);
  }

  const end = state.buffer.indexOf('\n\n');
  const frame = state.buffer.slice(0, end);

  state.buffer = state.buffer.slice(end + 2);

  return {
    event: frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7),
    data: JSON.parse(frame.split('\n').find((line) => line.startsWith('data: ')).slice(6)),
  };
}

for (const hostile of [false, true]) {
  test(`EVENT-0${hostile ? 2 : 1}: авторизованный SSE и ${hostile ? 'защита envelope' : 'два id'}`,
    async (t) => {
      const f = await runtimeFixture(t, [{ id: 'demo' }, { id: 'other' }], { sse: true });
      const demo = pluginCore(f);
      const other = pluginCore(f, 'other');
      const url = await f.app.listen({ port: 0, host: '127.0.0.1' });

      assert.equal((await fetch(`${url}/api/events`)).status, 401);

      const response = await fetch(`${url}/api/events`, { headers: f.session });
      const reader = response.body.getReader();
      const state = { buffer: '' };

      try {
        assert.equal(response.status, 200);
        assert.equal((await nextFrame(reader, state)).event, 'hello');

        const data = hostile ? {
          pluginId: 'other',
          event: 'state-change',
          text: '\r\nevent: hacked\n\n',
        } : 42;

        demo.emit(hostile ? 'state-change' : 'ready', data);
        other.emit('done');
        assert.deepEqual(await nextFrame(reader, state), {
          event: 'plugin-event',
          data: {
            pluginId: 'demo',
            event: hostile ? 'state-change' : 'ready',
            data,
          },
        });
        assert.deepEqual(await nextFrame(reader, state), {
          event: 'plugin-event',
          data: {
            pluginId: 'other',
            event: 'done',
            data: null,
          },
        });

        if (hostile) {
          for (const name of ['', 'x\ny', 'x\ry', 'x\0y', 'x'.repeat(129), null]) {
            assert.throws(() => demo.emit(name, {}), TypeError);
          }

          demo.emit('sentinel', null);
          assert.deepEqual(await nextFrame(reader, state), {
            event: 'plugin-event',
            data: {
              pluginId: 'demo',
              event: 'sentinel',
              data: null,
            },
          });
        }

      } finally {
        await reader.cancel();
      }
    });
}
