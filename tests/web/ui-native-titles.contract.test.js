import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { checkNativeTitles, findNativeTitles } from '../../web/scripts/check-native-titles.mjs';

const SCRIPT = fileURLToPath(new URL('../../web/scripts/check-native-titles.mjs', import.meta.url));
const ARTIFACT_PREFIX = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
  'title-tooltips/native-guard-');

test('TIP-GUARD-01: статичный title, bind с модификатором и обе ветки', () => {
  const source = `<template>
<span title="x" />
<UiButton v-if="ok" :title="y" />
<b v-else v-bind:title.attr="z" />
</template>`;

  assert.deepEqual(findNativeTitles(source, 'Example.vue'), [
    {
    file: 'Example.vue',
    line: 2,
    tag: 'span',
  },
    {
    file: 'Example.vue',
    line: 3,
    tag: 'UiButton',
  },
    {
    file: 'Example.vue',
    line: 4,
    tag: 'b',
  },
  ]);
});

test('TIP-GUARD-02: исключения, похожие слова и комментарии допустимы', () => {
  const source = `<template>
<option :title="label" /><iframe title="Кадр" /><UiDialog title="Диалог" />
<UiFloatingDialog title="Диалог" /><MiniChart title="Часы" /><ProjectAvatar title="Имя" />
<span data-title="x" /><!-- <span title="x" /> -->
</template><script setup>const title = 'title';</script>`;

  assert.deepEqual(findNativeTitles(source, 'Good.vue'), []);
});

test('TIP-GUARD-03: SVG title запрещён', () => {
  assert.deepEqual(findNativeTitles('<template><svg><title>x</title></svg></template>', 'Graph.vue'), [
    {
    file: 'Graph.vue',
    line: 1,
    tag: 'title',
  },
  ]);
});

test('TIP-GUARD-04: API и CLI возвращают ошибки чтения, разбора и пустого списка', (t) => {
  const root = fs.mkdtempSync(ARTIFACT_PREFIX);

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'Bad.vue'), '<template><span title="x" /></template>');
  fs.writeFileSync(path.join(root, 'Good.vue'), '<template><span data-title="x" /></template>');
  fs.writeFileSync(path.join(root, 'Broken.vue'), '<template><span></template>');
  assert.equal(checkNativeTitles({ repoRoot: root, files: ['Bad.vue'] }).errors.length > 0, true);

  for (const [file, expected] of [
    ['Bad.vue', 1], ['Missing.vue', 1], ['Broken.vue', 1], ['Good.vue', 0],
  ]) {
    const result = spawnSync(process.execPath, [
      SCRIPT, '--files', path.join(root, file),
    ], { encoding: 'utf8' });

    assert.equal(result.status, expected, result.stderr);
  }

  const empty = spawnSync(process.execPath, [SCRIPT, '--files']);

  assert.equal(empty.status, 1);
});

test('TIP-GUARD-05: общий UI-сторож запускает проверку title', () => {
  const source = fs.readFileSync(new URL('../../web/scripts/check-ui-suite.mjs', import.meta.url), 'utf8');

  assert.match(source, /\['native title', checkNativeTitles\]/);
});
