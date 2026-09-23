// Источники связей проекта: правила Telegram и GitHub и записи знаний.
//
// Эти три раздела хранят ссылку на проект не в файле настроек, а у себя: правила —
// в контексте подключённого аккаунта, знания — в своей базе. Считать их приходится
// через чужой порт, и важно ровно одно: «связей нет» и «проверить не удалось» не
// должны выглядеть одинаково, иначе архив либо порвёт правило, либо не пройдёт никогда.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countGitHubRules,
  countKnowledgeRecords,
  countTelegramRules,
} from '../../server/src/lib/projects/dependencySources.ts';

/** Двойник аккаунта: отдаёт lease с правилами и помнит, что его освободили. */
function connectionDouble({
  configured = true,
  connection = 'connected',
  rules = [],
  fail = null,
  current = true,
} = {}) {
  const state = { released: 0, reads: 0 };
  const lease = {
    context: {
      rules: {
        read: async () => {
          state.reads += 1;

          if (fail) {
            throw new Error(fail);
          }

          return rules;
        },
      },
    },
    isCurrent: () => current,
    release: () => {
      state.released += 1;
    },
  };

  return {
    state,
    status: async () => ({ configured, connection }),
    acquireLease: () => lease,
    acquireInboxLease: () => lease,
  };
}

test('правила Telegram считаются по project и не раскрывают адреса чатов', async () => {
  const connection = connectionDouble({
    rules: [
      { project: 'demo', chatId: -100500, username: 'secret_chat', title: 'Рабочий чат' },
      { project: 'other', chatId: -100777, username: 'another', title: 'Чужой' },
      { project: 'demo', chatId: null, username: 'demo_public', title: 'Второй' },
    ],
  });

  const found = await countTelegramRules(connection, 'demo');

  assert.equal(found.count, 2);
  // Идентификаторы чатов — runtime-данные соседнего раздела: сводке хватает числа.
  assert.deepEqual(found.items ?? [], []);
  assert.equal(connection.state.released, 1, 'lease обязан освобождаться');
});

test('неподключённый аккаунт Telegram — это ноль связей, а не отказ проверки', async () => {
  const connection = connectionDouble({ configured: false, connection: 'idle', rules: [{ project: 'demo' }] });

  const found = await countTelegramRules(connection, 'demo');

  assert.equal(found.count, 0);
  assert.equal(connection.state.reads, 0, 'правила неподключённого аккаунта не читаются');
});

test('отказ чтения правил Telegram доезжает до сводки ошибкой', async () => {
  const connection = connectionDouble({ fail: 'диск не читается', rules: [] });

  await assert.rejects(() => countTelegramRules(connection, 'demo'), /диск не читается/u);
  assert.equal(connection.state.released, 1, 'lease освобождается и на отказе');
});

test('протухший lease Telegram не считается проверкой', async () => {
  const connection = connectionDouble({ current: false, rules: [{ project: 'demo' }] });

  await assert.rejects(() => countTelegramRules(connection, 'demo'), /аккаунт/iu);
  assert.equal(connection.state.released, 1);
});

test('правила GitHub считаются своим lease', async () => {
  const connection = connectionDouble({
    rules: [{ project: 'demo', repositoryId: 'owner/repo' }, { project: 'demo' }, { project: 'nope' }],
  });

  const found = await countGitHubRules(connection, 'demo');

  assert.equal(found.count, 2);
  assert.deepEqual(found.items ?? [], []);
  assert.equal(connection.state.released, 1);
});

test('записи знаний считаются по проекту, а недоступная база — отказ проверки', async () => {
  const knowledge = {
    list: async ({ project }) => {
      assert.equal(project, 'demo');

      return { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    },
  };

  assert.equal((await countKnowledgeRecords(knowledge, 'demo')).count, 3);

  const broken = {
    list: async () => {
      throw new Error('worker знаний недоступен');
    },
  };

  await assert.rejects(() => countKnowledgeRecords(broken, 'demo'), /worker знаний недоступен/u);
});
