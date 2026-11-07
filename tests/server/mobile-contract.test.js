import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { ContractError, decodeContract } from '../../server/src/lib/mobile/contract.ts';

const directory = new URL('../fixtures/mobile-contract/v1/', import.meta.url);

test('MC-01/MC-02: golden v1, обязательные поля, enum и необязательные будущие поля', async () => {
  const names = await readdir(directory);

  assert.ok(names.length >= 20);

  for (const name of names.filter((file) => file.endsWith('.json'))) {
    const value = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
    const kind = name.replace('.json', '').replace(/-(empty|future|large)$/, '');

    assert.deepEqual(decodeContract(kind, value), value);
    assert.deepEqual(
      decodeContract(kind, {
        ...value,
        futureOptional: 'Совместимое добавление',
      }),
      {
        ...value,
        futureOptional: 'Совместимое добавление',
      },
    );

    for (const field of Object.keys(value).slice(0, 1)) {
      const absent = { ...value };

      delete absent[field];
      assert.throws(() => decodeContract(kind, absent), ContractError);
      assert.throws(
        () =>
          decodeContract(kind, {
            ...value,
            [field]: Array.isArray(value[field]) ? 'не массив' : [],
          }),
        ContractError,
      );
    }
  }
});

test('MC-02/MC-40: неизвестный enum, неправильный nullable и более 2 МиБ закрывают контракт', async () => {
  const chat = JSON.parse(await readFile(new URL('chat.json', directory), 'utf8'));

  assert.throws(
    () =>
      decodeContract('chat', {
        ...chat,
        chat: {
          ...chat.chat,
          state: 'new-state',
        },
      }),
    (error) => error instanceof ContractError && error.path === '$.chat.state',
  );
  assert.throws(
    () =>
      decodeContract('chat', {
        ...chat,
        chat: {
          ...chat.chat,
          taskId: 1,
        },
      }),
    ContractError,
  );
  assert.throws(
    () =>
      decodeContract('plan', {
        text: 'x'.repeat(2 * 1024 * 1024),
        contentRevision: 'a'.repeat(64),
        hasMore: false,
        nextOffset: null,
        readToken: null,
      }),
    ContractError,
  );
});
