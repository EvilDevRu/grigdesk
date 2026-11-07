import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeUserPluginManifest, scanUserPlugins } from '../../server/src/lib/pluginsRegistry.ts';
import { validatePluginPackage } from '../../server/src/lib/packageInstall/validatePackage.ts';
import { expectedPackage, manifestV1, packageV1 } from '../helpers/pluginV1.js';
import { runtimeFixture } from './helpers/pluginRuntimeFixture.js';
import { comboIssue } from '../../web/src/shared/hotkeys/combo.ts';

/**
 * Hotkey принадлежит декларации единственной панели, остальные поля не меняются.
 * Один вход используется decoder, scanner и настоящим installer validator.
 */
function manifestWithHotkey(hotkey) {
  const manifest = manifestV1();

  manifest.contributes.panels[0].hotkey = hotkey;

  return manifest;
}

for (const [label, value] of [
  ['empty', ''],
  ['noncanonical', 'Shift+Ctrl+Digit7'],
  ['spaces', 'Ctrl + Shift + Digit7'],
  ['duplicate', 'Ctrl+Ctrl+Digit7'],
  ['typing', 'Shift+KeyK'],
  ['system-meta', 'Ctrl+Meta+KeyK'],
  ['browser-reserved', 'Ctrl+KeyC'],
  ['digit-reserved', 'Alt+Digit7'],
  ['unknown-key', 'Ctrl+Enter'],
  ['length', `Ctrl+${'a'.repeat(65)}`],
  ['null', null],
  ['boolean', true],
  ['number', 42],
  ['array', ['Ctrl+Shift+Digit7']],
  ['object', { toString: () => 'Ctrl+Shift+Digit7' }],
]) {
  test(`PH-MANIFEST-REFUSAL: ${label} не исполняется как внешнее сочетание`, async (t) => {
    const manifest = manifestWithHotkey(value);

    assert.throws(() => decodeUserPluginManifest(manifest, () => {}, '1.0.0'), {
      code: 'manifest_invalid',
    });

    const f = await packageV1(t, manifest);
    const [card] = await scanUserPlugins(f.root, { warn() {} }, '1.0.0');

    assert.equal(card.compatibility.status, 'incompatible');
    await assert.rejects(validatePluginPackage(f.dir, expectedPackage), { code: 'manifest_invalid' });
  });
}

for (const hotkey of ['Ctrl+Shift+Digit7', 'Ctrl+Alt+KeyK']) {
  test(`PH-MANIFEST: canonical ${hotkey} сохраняется scanner/validator/HTTP`, async (t) => {
    const f = await packageV1(t, manifestWithHotkey(hotkey));
    const [card] = await scanUserPlugins(f.root, { warn() {} }, '1.0.0');

    assert.equal(card.contributes.panels[0].hotkey, hotkey);
    assert.equal((await validatePluginPackage(f.dir, expectedPackage)).webModuleDir, 'ui');

    const app = await runtimeFixture(t, [{
      id: 'demo',
      web: true,
      manifest: { contributes: { panels: [{ hotkey }] } },
    }]);

    assert.equal((await app.card('demo')).contributes.panels[0].hotkey, hotkey);
  });
}

test('PH-MANIFEST: прежний v1 без hotkey остаётся совместимым', () => {
  const decoded = decodeUserPluginManifest(manifestV1(), () => {}, '1.0.0');

  assert.equal(Object.hasOwn(decoded.contributes.panels[0], 'hotkey'), false);
});

test('PH-REASON-I18N: общие причины остаются переводимыми RU/EN после extraction', () => {
  const examples = ['Ctrl+Enter', 'Ctrl+Meta+KeyK', 'Shift+KeyK', 'Ctrl+Alt+KeyS', 'Alt+Digit7'];

  for (const value of examples) {
    const ru = comboIssue(value, 'ru');
    const en = comboIssue(value, 'en');

    assert.equal(typeof ru, 'string');
    assert.equal(typeof en, 'string');
    assert.ok(ru.length > 0);
    assert.ok(en.length > 0);
    assert.notEqual(ru, en);
    assert.match(ru, /[а-яё]/iu);
    assert.doesNotMatch(en, /[а-яё]/iu);
    assert.doesNotMatch(`${ru}\n${en}`, /(?:^|\n|:\s)settings\.|\{reason\}/u);
  }

  assert.equal(comboIssue('Ctrl+Shift+Digit7', 'ru'), '');
  assert.equal(comboIssue('Ctrl+Shift+Digit7', 'en'), '');
});
