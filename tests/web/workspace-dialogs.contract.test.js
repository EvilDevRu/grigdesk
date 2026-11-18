import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { webFile } from './helpers/compile-vue.js';

test('DiffModal и DocumentModal используют единый dialog runtime без legacy stack', async () => {
  const [diff, document, dialog, overlays, runtime] = await Promise.all([
    readFile(webFile('src/views/DiffModal.vue'), 'utf8'),
    readFile(webFile('src/views/DocumentModal.vue'), 'utf8'),
    readFile(webFile('src/components/overlays/UiDialog.vue'), 'utf8'),
    readFile(webFile('src/styles/components/overlays.css'), 'utf8'),
    readFile(webFile('src/styles/runtime.css'), 'utf8'),
  ]);

  for (const source of [diff, document]) {
    assert.match(source, /<UiDialog/);
    assert.match(source, /:close-label=/);
    assert.match(source, /:body-inset="false"/);
    assert.doesNotMatch(source, /registerLayer|layer-stack|<Transition|<button/);
  }

  assert.match(diff, /layer="diff-workspace"/);
  assert.match(document, /layer="document"/);
  assert.match(dialog, /bodyInset\?: boolean/);
  assert.match(dialog, /:data-body-inset="bodyInset \? 'true' : 'false'"/);
  assert.match(overlays, /\.ui-dialog\[data-body-inset='false'\] \.ui-dialog__body/);
  assert.match(runtime, /data-ui-layer='diff-workspace'/);
});

test('Модальный HTML в ядре принадлежит UiDialog', async () => {
  const files = (await readdir(webFile('src'), { recursive: true }))
    .filter((name) => name.endsWith('.vue') && name !== 'components/overlays/UiDialog.vue');
  const violations = [];

  for (const file of files) {
    const source = await readFile(webFile(`src/${file}`), 'utf8');
    const template = source.split('<script', 1)[0];

    if (/<dialog\b|\b(?:aria-modal="true"|role="(?:dialog|alertdialog)")/u.test(template)) {
      violations.push(file);
    }
  }

  assert.deepEqual(violations, []);
});

test('Действия TaskModal используют общее оформление из UI-kit', async () => {
  const [taskModal, actions] = await Promise.all([
    readFile(webFile('src/views/TaskModal.vue'), 'utf8'),
    readFile(webFile('src/styles/components/actions.css'), 'utf8'),
  ]);

  assert.equal(
    [...taskModal.matchAll(/data-context="task-footer-action"/gu)].length,
    9,
  );

  const footerRule = actions.match(/data-context='task-footer-action'\]\s*\{([^}]+)\}/u)?.[1];

  assert.ok(footerRule, 'Общий skin действий TaskModal существует');
  assert.match(footerRule, /height:\s*auto;/u);
  assert.match(footerRule, /min-height:\s*var\(--control-height\);/u);
});
