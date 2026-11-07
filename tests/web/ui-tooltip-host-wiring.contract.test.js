import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('TIP-WIRE-01: хост доступен сразу после общего диалога', async () => {
  const source = await readFile(new URL('../../web/src/App.vue', import.meta.url), 'utf8');

  assert.match(source, /<UiDialogHost\s*\/>\s*<UiTooltipHost\s*\/>/);
});

test('TIP-WIRE-02: общий фасад экспортирует хост и директиву', async () => {
  const source = await readFile(new URL('../../web/src/ui.ts', import.meta.url), 'utf8');

  assert.match(source, /export.*UiTooltipHost.*UiTooltipHost\.vue/);
  assert.match(source, /export.*vTooltip.*tooltipDirective/);
});
