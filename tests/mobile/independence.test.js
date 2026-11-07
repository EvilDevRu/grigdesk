import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(new URL('../../mobile/src', import.meta.url).pathname);

/**
 * Собирает только собственные исходники приложения, проверяя фактические пути.
 * Symlink не разрешает молча подключить соседний продуктовый пакет.
 */
async function sources(directory) {
  const result = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const resolved = await realpath(file);

    assert.equal(resolved.startsWith(`${root}/`), true);

    if (entry.isDirectory()) {
      result.push(...(await sources(file)));
    } else {
      result.push(file);
    }
  }

  return result;
}

test('MA-01/MA-02/MA-03/MA-40: независимые исходники, текст и масштабируемые копии стилей', async () => {
  const files = await sources(root);
  const css = files.filter((file) => file.endsWith('.css'));

  assert.equal(css.length >= 3, true);

  for (const file of files) {
    const text = await readFile(file, 'utf8');

    assert.equal(/v-html|innerHTML/.test(text), false, file);
    assert.equal(/font-size\s*:\s*[\d.]+px/.test(text), false, file);

    for (const match of text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) {
        assert.equal(path.resolve(path.dirname(file), match[1]).startsWith(`${root}/`), true, file);
      }

      assert.equal(/\/(?:web|shared|server)\//.test(match[1]), false, file);
    }

    if (file.endsWith('.css')) {
      assert.equal(text.startsWith('/* Копия '), true, file);
    }
  }
});
