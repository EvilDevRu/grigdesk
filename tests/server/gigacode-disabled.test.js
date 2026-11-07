import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

import { getExecutors, getProviderAdapters } from '../../server/src/lib/executors/index.ts';
import { executorLoaders } from '../../server/src/lib/executors/registryTable.ts';

test('GigaCode временно отсутствует в карточках, моделях и реестре запуска чатов', async () => {
  assert.equal(executorLoaders().some((loader) => loader.name === 'gigacode'), false);
  assert.equal((await getProviderAdapters()).has('gigacode'), false);
  assert.equal((await getExecutors()).has('gigacode'), false);
});

test('исходники GigaCode сохранены вне автоматических загрузчиков чата и Factory', async () => {
  for (const relative of [
    'server/src/lib/executors/gigacode.ts',
    'engine/lib/runners/gigacode.sh',
    'server/scripts/gigacodeRunner.mts',
  ]) {
    const source = new URL(`../../${relative}`, import.meta.url);

    await assert.rejects(access(source), { code: 'ENOENT' });
    await access(new URL(`${source.href}.disabled`));
  }
});
