import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ArbiterConversationStore } from '../../server/src/lib/arbiterConversationStore.ts';

const identity = {
  task: '123',
  profile: 'sample',
  attempt: `a_${'a'.repeat(32)}`,
  node: 'verify',
  stop: 'human',
  stageSequence: 3,
  stageHeadHash: 'b'.repeat(64),
};
const capabilities = {
  status: 'unknown',
  message: 'Проверка поддержки ещё не выполнена.',
  targets: []
};

/**
 * Каждая проверка владеет только своей папкой и удаляет её после завершения.
 * Повторное создание store проверяет именно сохранённые байты, а не кэш экземпляра.
 */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arbiter-conversation-'));

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  return { dir, store: new ArbiterConversationStore(dir) };
}

test('exact stop создаётся один раз; параллельные записи и перезапуск сохраняют порядок', async (t) => {
  const { dir, store } = await fixture(t);
  const [first, same] = await Promise.all([
    store.create(identity, capabilities), store.create(identity, capabilities),
  ]);

  assert.equal(first.id, same.id);
  await Promise.all(['Первое', 'Второе'].map((text) => store.append('123', first.id, {
    author: 'human',
    text,
    status: 'complete',
  })));

  const reopened = await new ArbiterConversationStore(dir).read('123', first.id);

  assert.deepEqual(reopened.messages.map((row) => row.text), ['Первое', 'Второе']);
  assert.deepEqual(reopened.messages.map((row) => row.sequence), [1, 2]);
  assert.equal((await fs.stat(store.file('123', first.id))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(store.file('123', first.id)))).mode & 0o777, 0o700);
});

test('sourceRevision игнорирует старую дельту, id не дублируется, страницы ограничены', async (t) => {
  const { store } = await fixture(t);
  const doc = await store.create(identity, capabilities);
  const message = {
    id: 'frame-1',
    author: 'arbiter',
    turnId: 'turn-1',
    sourceId: 'source-1',
    sourceRevision: 2,
    text: 'Полный текст',
    status: 'partial'
  };

  await store.append('123', doc.id, message);
  await store.append('123', doc.id, {
    ...message,
    sourceRevision: 1,
    text: 'Пол'
  });

  const snapshot = await store.snapshot('123', doc.id, { afterSequence: 1, knownRevision: doc.revision });

  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].text, 'Полный текст');
  assert.equal((await store.read('123', doc.id)).messages.length, 1);
});

test('битая схема и отказ записи не превращаются в успешную пустую историю', async (t) => {
  const { store } = await fixture(t);
  const doc = await store.create(identity, capabilities);

  await fs.writeFile(store.file('123', doc.id), '{"schemaVersion":99}');
  await assert.rejects(store.read('123', doc.id), { code: 'storage_failed' });
  await fs.rm(store.file('123', doc.id));
  await fs.mkdir(store.file('123', doc.id));
  await assert.rejects(store.create(identity, capabilities), { code: 'storage_failed' });
});

test('удаление попытки изолировано; поздний callback не восстанавливает удалённое', async (t) => {
  const { store } = await fixture(t);
  const first = await store.create(identity, capabilities);
  const second = await store.create({ ...identity, attempt: `a_${'c'.repeat(32)}` }, capabilities);

  await store.removeAttempt('123', identity.attempt);
  await assert.rejects(store.append('123', first.id, {
    author: 'arbiter',
    text: 'Поздний ответ',
    status: 'complete'
  }), { code: 'conversation_deleted' });
  assert.equal((await store.read('123', second.id)).id, second.id);
  await store.removeTask('123');
  assert.equal(await store.read('123', second.id), null);
});

test('очистка оставляет активный и архивный owner, не удаляет при ошибке реестра', async (t) => {
  const { dir, store } = await fixture(t);
  const doc = await store.create(identity, capabilities);

  await store.reconcileOwners(async () => {
    throw new Error('Реестр недоступен');
  });
  assert.equal((await store.read('123', doc.id)).id, doc.id);
  await store.reconcileOwners(async () => 'present');
  assert.equal((await store.read('123', doc.id)).id, doc.id);
  await new ArbiterConversationStore(dir).reconcileOwners(async () => 'absent');
  assert.equal(await store.read('123', doc.id), null);
});

test(("история больше страницы восстанавливается целиком; обновлённый partial " +
  "приходит по revision"),
  async (t) => {
    const { store } = await fixture(t);
    const doc = await store.create(identity, capabilities);

    await store.update('123', doc.id, (current) => {
      current.messages = Array.from({ length: 205 }, (_, index) => ({
        id: `message-${index + 1}`,
        sequence: index + 1,
        author: 'arbiter',
        text: `Сообщение ${index + 1}`,
        status: 'partial',
        revision: current.revision + 1,
        createdAt: current.createdAt,
      }));
    });

    const ids = [];
    let afterSequence = 0;
    let page;

    do {
      page = await store.snapshot('123', doc.id, { afterSequence });
      ids.push(...page.messages.map((row) => row.id));
      afterSequence = page.afterSequence;
      assert.equal(page.messages.length <= 100, true);
    } while (page.hasMore);

    assert.equal(ids.length, 205);
    assert.equal(new Set(ids).size, 205);

    const revision = page.revision;

    await store.update('123', doc.id, (current) => {
      current.messages[0].text = 'Дополненная первая реплика';
      current.messages[0].revision = current.revision + 1;
    });

    const changed = await store.snapshot('123', doc.id, { afterSequence, knownRevision: revision });

    assert.equal(changed.messages.length, 1);
    assert.equal(changed.messages[0].text, 'Дополненная первая реплика');
  }
);

test('повреждённые вложенные поля операции закрывают чтение до вызова внешнего эффекта', async (t) => {
  const { store } = await fixture(t);
  const doc = await store.create(identity, capabilities);

  doc.operations.push({
    id: 'apply',
    requestId: 'request',
    fingerprint: 'a'.repeat(64),
    kind: 'apply',
    outcome: 'accepted',
    createdAt: doc.createdAt,
    updatedAt: doc.createdAt,
    receipt: { stage: { sequence: -1, headEventHash: 'invalid' } },
  });
  await fs.writeFile(store.file('123', doc.id), JSON.stringify(doc));
  await assert.rejects(store.read('123', doc.id), { code: 'storage_failed' });
});

test('startup сохраняет реальные активные и архивные данные; удаляет только подтверждённую сироту',
  async (t) => {
    const { createRequire } = await import('node:module');
    const { registerArbiterConversationRuntime } = await import(
      '../../server/src/modules/factory/arbiterConversationRuntime.ts'
    );
    const Fastify = createRequire(new URL('../../server/package.json', import.meta.url))('fastify');
    const { dir, store } = await fixture(t);
    const stateDir = path.join(dir, 'state');
    const archiveDir = path.join(stateDir, 'archive');

    await fs.mkdir(archiveDir, { recursive: true });

    const doc = await store.create(identity, capabilities);
    const active = path.join(stateDir, 't123.env');
    const archived = path.join(archiveDir, 't123.env');

    await fs.writeFile(active, '');

    for (const phase of ['active', 'archived', 'absent']) {
      if (phase === 'archived') {
        await fs.rename(active, archived);
      }
      if (phase === 'absent') {
        await fs.rm(archived);
      }

      const app = Fastify();
      const reopened = new ArbiterConversationStore(dir);

      await registerArbiterConversationRuntime(app, {
        config: { stateDir, factoryControlDir: path.join(dir, 'control') },
        factoryState: {},
      }, reopened, async () => {
        assert.fail('Очистка не выбирает модель');
      }, async () => {
        assert.fail('Очистка не запускает попытку');
      });
      assert.equal(Boolean(await reopened.read('123', doc.id)), phase !== 'absent');
      await app.close();
    }
  });
