import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('SM-01: главный процесс подключает закрытый адаптер и роль до loadURL', async () => {
  const source = await readFile(new URL('../../desktop/src/main.ts', import.meta.url), 'utf8');

  assert.match(source, /createSurfaceWindows\(\{/);
  assert.match(source, /create: createSurfaceWindow,/);
  assert.match(source, /nativeWindows:\s*\{/);
  assert.match(source, /desktopUserAgent\(window\.webContents\.getUserAgent\(\), 'surface'\)/);
  assert.match(source, /surfaceWindows\?\.closeAll\(\)/);
  assert.doesNotMatch(source, /deliver:/);
});
