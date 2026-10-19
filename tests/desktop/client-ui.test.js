import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporary } from '../relay/helpers.js';
import { prepareClientUi } from '../../tools/client-ui.mts';
import { verifyUiRelease } from '../../desktop/src/uiRelease.ts';

test('общая сборка запечатывает UI с версией API, рабочий dist не меняется', async (t) => {
  const root = await temporary(t);
  const destination = path.join(root, 'resources/ui');
  const existing = path.join(root, 'web/dist');

  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, 'sentinel'), 'working-dist');
  await prepareClientUi({
    destination,
    root,
    /**
     * Подмена компилятора создаёт только файлы в переданном staging.
     * Проверяется публикация пакета, а не повторная работа Vite.
     */
    async run(_command, args) {
      const output = args[args.indexOf('--outDir') + 1];

      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'index.html'), '<h1>Машины</h1>');

      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(await readFile(path.join(destination, 'api-version.json'), 'utf8')
    .then((text) => JSON.parse(text).minor, () => null), 1);
  assert.ok((await verifyUiRelease(destination)).files.some((file) => file.path === 'api-version.json'));
  assert.equal(await readFile(path.join(existing, 'sentinel'), 'utf8'), 'working-dist');
  await assert.rejects(prepareClientUi({
    destination,
    root,
    run: async () => {
      throw new Error('synthetic build failure');
    },
  }), /synthetic build failure/);
  assert.equal(await readFile(path.join(destination, 'index.html'), 'utf8'), '<h1>Машины</h1>');
});
