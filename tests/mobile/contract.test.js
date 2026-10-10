import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { decodeContract, ContractError } from '../../mobile/src/api/contract.ts';

const root = new URL('../fixtures/mobile-contract/v1/', import.meta.url);

test('MA-04/05: независимый decoder принимает golden и отвергает повреждённый контракт', async () => {
  for (const name of (await readdir(root)).filter((file) => file.endsWith('.json'))) {
    const kind = name.replace('.json', '').replace(/-(empty|future|large)$/, '');
    const value = JSON.parse(await readFile(new URL(name, root), 'utf8'));

    assert.deepEqual(decodeContract(kind, value), value);
    assert.throws(() => decodeContract(kind, []), ContractError);
  }

  assert.throws(() => decodeContract('hello', { api: 2 }), ContractError);
});

test('MC-40: замороженный decoder принимает optional добавление и отвергает сломанный enum/поле',
  async () => {
  const { decodeContract: previous } =
    await import('../fixtures/mobile-contract/baseline/contract.ts');
  const chat = JSON.parse(await readFile(new URL('chat.json', root), 'utf8'));
  const compatible = {
    ...chat,
    futureOptional: { value: 'новое поле' },
  };

  assert.deepEqual(previous('chat', compatible), compatible);
  assert.throws(() =>
    previous('chat', {
      ...chat,
      chat: {
        ...chat.chat,
        state: 'future-running',
      },
    }),
  );

  const missing = { ...chat };

  delete missing.messages;
  assert.throws(() => previous('chat', missing));
  assert.deepEqual(previous('chat', decodeContract('chat', chat)), chat);
});
