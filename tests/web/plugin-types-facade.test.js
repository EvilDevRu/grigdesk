import assert from 'node:assert/strict';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import {
  assertFacadeSubset, builtPackage, compilerLease, declarationValues,
} from './helpers/pluginTypes.mjs';
import { buildRuntime, expectedUiExports, runtimeMap } from './helpers/pluginRuntimeFixture.mjs';

let fixturePromise;

/**
 * Декларации и runtime получаются независимыми путями: checker и production import map.
 * Оба случая используют одну настоящую сборку, повреждается только копия метаданных.
 */
function facadeFixture() {
  fixturePromise ??= (async () => {
    const directory = await builtPackage();
    const declarations = declarationValues(path.join(directory, 'ui.d.ts'));
    const built = await compilerLease(() => buildRuntime());
    const map = runtimeMap(built);
    const chunk = built.output.find((item) => './' + item.fileName === map.imports['@grigdesk/ui']);

    assert.equal(chunk?.type, 'chunk');
    assert.deepEqual([...chunk.exports].sort(), await expectedUiExports());
    assert.ok(declarations.includes('UiButton'));

    for (const name of ['UiActionTone', 'UI_ACTION_SIZES', 'UI_ACTION_TONES', 'UI_ACTION_VARIANTS',
      'normalizeActionSize', 'normalizeActionTone', 'normalizeActionVariant']) {
      assert.ok(!declarations.includes(name), `Type-only экспорт ${name} не является runtime-значением`);
    }

    return {
      declarations,
      exports: chunk.exports,
      built,
    };
  })();

  return fixturePromise;
}

test.after(async () => {
  if (fixturePromise) {
    const fixture = await fixturePromise.catch(() => null);

    if (fixture) {
      await rm(fixture.built.directory, { recursive: true, force: true });
    }
  }
});

test('TSDK-FACADE-SUBSET: значения UI деклараций существуют в настоящем runtime chunk', async () => {
  const fixture = await facadeFixture();

  assertFacadeSubset(fixture.declarations, fixture.exports);
});

test('TSDK-FACADE-MISSING: потеря UiButton в копии runtime выявляется с именем экспорта', async () => {
  const fixture = await facadeFixture();
  const original = [...fixture.exports];
  const damaged = fixture.exports.filter((name) => name !== 'UiButton');

  assert.throws(() => assertFacadeSubset(fixture.declarations, damaged), /UiButton/);
  assert.deepEqual(fixture.exports, original);
  assertFacadeSubset(fixture.declarations, fixture.exports);
});
