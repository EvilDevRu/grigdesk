import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TelegramAccountBindings,
  botIdFromIdentity,
  generateTelegramAccountRef,
  normalizeTelegramBotIdentity,
  telegramBotIdentity,
} from '../../server/src/lib/telegram/accountBindings.ts';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-bindings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let random = 0;
  let clock = 1_800_000_000_000;
  const store = new TelegramAccountBindings({
    file: path.join(dir, 'account-bindings.json'),
    randomBytes(size) {
      random += 1;
      return Buffer.alloc(size, random);
    },
    now() { clock += 1; return clock; },
  });
  return { dir, file: store.file, store };
}

test('provider identity использует только immutable getMe bot.id', () => {
  assert.deepEqual(telegramBotIdentity(8123456789), [1, 'api.telegram.org', 'bot', '8123456789']);
  assert.equal(botIdFromIdentity([1, 'api.telegram.org', 'bot', '8123456789']), '8123456789');
  for (const bad of [
    [1, 'api.telegram.org', 'bot', 8123456789],
    [1, 'api.telegram.org', 'bot', '08123456789'],
    [1, 'telegram.org', 'bot', '8123456789'],
    [1, 'api.telegram.org', 'username', 'my_bot'],
  ]) assert.throws(() => normalizeTelegramBotIdentity(bad), /identity|tuple|canonical/i);
});

test('accountRef генерируется без registry mutation', async (t) => {
  const { store, file } = await fixture(t);
  const accountRef = generateTelegramAccountRef((size) => Buffer.alloc(size, 7));
  assert.match(accountRef, /^acc_[A-Za-z0-9_-]+$/u);
  assert.equal((await store.read()).bindings.length, 0);
  await assert.rejects(() => readFile(file), (error) => error.code === 'ENOENT');
});

test('тот же bot переиспользует accountRef, новый bot получает пустой namespace owner', async (t) => {
  const { store, file } = await fixture(t);
  const first = await store.resolveOrCreate(telegramBotIdentity(8123456789));
  const again = await store.resolveOrCreate(telegramBotIdentity(8123456789));
  const second = await store.resolveOrCreate(telegramBotIdentity(9123456789));

  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.binding.accountRef, first.binding.accountRef);
  assert.notEqual(second.binding.accountRef, first.binding.accountRef);
  assert.equal((await store.selected()).accountRef, second.binding.accountRef);

  await store.select(first.binding.accountRef);
  assert.equal((await store.selected()).accountRef, first.binding.accountRef);
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(persisted).sort(), [
    'bindings', 'channel', 'schemaVersion', 'selectedAccountRef', 'updatedAtMs',
  ]);
  assert.equal(persisted.channel, 'telegram');
  assert.equal((await store.byAccountRef(second.binding.accountRef)).providerIdentity[3], '9123456789');
});

test('concurrent resolve одного bot сериализован и не создаёт duplicate mapping', async (t) => {
  const { store } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => (
    store.resolveOrCreate(telegramBotIdentity(8123456789))
  )));
  assert.equal(new Set(results.map((result) => result.binding.accountRef)).size, 1);
  assert.equal((await store.read()).bindings.length, 1);
});

test('duplicate/corrupt owner fail-closed и не переписывается', async (t) => {
  const { file, store } = await fixture(t);
  const first = await store.resolveOrCreate(telegramBotIdentity(8123456789));
  const raw = JSON.parse(await readFile(file, 'utf8'));
  raw.bindings.push({ ...raw.bindings[0], accountRef: `${first.binding.accountRef}x` });
  await writeFile(file, `${JSON.stringify(raw)}\n`);

  await assert.rejects(
    () => store.resolveOrCreate(telegramBotIdentity(9123456789)),
    (error) => error.code === 'telegram_binding_conflict',
  );
  assert.equal(JSON.parse(await readFile(file, 'utf8')).bindings.length, 2);
});

test('account-bindings symlink не читается и не заменяется', async (t) => {
  const { dir } = await fixture(t);
  const target = path.join(dir, 'real.json');
  const link = path.join(dir, 'linked.json');
  await writeFile(target, '{}');
  await symlink(target, link);
  const store = new TelegramAccountBindings({ file: link });
  await assert.rejects(
    () => store.read(),
    (error) => error.code === 'telegram_bindings_unsafe',
  );
  assert.equal(await readFile(target, 'utf8'), '{}');
});
