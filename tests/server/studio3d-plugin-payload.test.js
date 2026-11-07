import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { scanUserPlugins } from '../../server/src/lib/pluginsRegistry.ts';
import { validatePluginPackage } from '../../server/src/lib/packageInstall/validatePackage.ts';
import { png } from '../helpers/pluginV1.js';

const artifacts = '/home/evildev/.grigdesk/artifacts/studio3d-extraction';
const payload = process.env.STUDIO3D_PAYLOAD_DIR;
const expected = {
  version: '1.0.0',
  expectedId: 'studio3d',
  reservedIds: new Set(),
  grigDeskVersion: '0.1.0',
};

if (payload !== undefined) {
  assert.equal(path.isAbsolute(payload), true, 'STUDIO3D_PAYLOAD_DIR должен быть абсолютным');
  await readFile(path.join(payload, 'plugin.json'));
}

/**
 * Старый manifest имеет все ordinary ресурсы: RED означает отказ поведения decoder,
 * а не отсутствие импортируемого кода, файла или зависимости теста.
 */
async function oldCandidate(t) {
  const root = await mkdtemp(path.join(artifacts, 'payload-old-'));
  const directory = path.join(root, 'studio3d');
  const files = {
    'plugin.json': JSON.stringify({
      id: 'studio3d',
      api: 1,
      name: '3D',
      version: '1.0.0',
      description: 'Старая форма с полными ресурсами',
      icon: 'assets/icon.png',
      nav: { path: '/3d', label: '3D' },
      webModule: { dir: 'ui', entry: 'panel.js' },
      settings: [],
    }),
    'assets/icon.png': png,
    'server.mjs': 'export default async function plugin() {}\n',
    'ui/panel.js': 'export default { render() { return null; } };\n',
    'ui/background.js': 'export function start() {}\n',
    'ui/panel.css': '.studio3d {}\n',
    'ui/locales/ru.json': '{}\n',
    'ui/locales/en.json': '{}\n',
  };

  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  return { root, directory };
}

test('PAYLOAD-OLD существующие validator/scanner отвергают полный ordinary старый пакет', async (t) => {
  const fixture = await oldCandidate(t);

  await assert.rejects(validatePluginPackage(fixture.directory, expected), { code: 'manifest_incompatible' });

  const scanned = await scanUserPlugins(fixture.root, undefined, expected.grigDeskVersion);

  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].compatibility.status, 'incompatible');
  assert.equal(scanned[0].compatibility.code, 'manifest_incompatible');
});

test('PAYLOAD-COMPAT actual validator и scanner принимают готовый Studio3D v1 payload', {
  skip: payload === undefined && 'Нужен STUDIO3D_PAYLOAD_DIR: изолированный build output шага13.',
}, async (t) => {
  // Reserved namespace проверяется отдельно настоящим SYSTEM на шагах15/16.
  // Здесь существующий validator проверяет формат и весь ordinary payload без установки.
  const result = await validatePluginPackage(payload, expected)
    .then((value) => ({ accepted: true, value }), (error) => ({ accepted: false, code: error.code }));

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.value.id, 'studio3d');
  assert.equal(result.value.serverEntry, 'server.mjs');
  assert.equal(result.value.webModuleDir, 'ui');
  assert.deepEqual(result.value.npmDirs, []);

  const root = await mkdtemp(path.join(artifacts, 'payload-scan-'));
  const directory = path.join(root, 'studio3d');
  const { cp } = await import('node:fs/promises');

  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(payload, directory, { recursive: true });

  const scanned = await scanUserPlugins(root, undefined, expected.grigDeskVersion);
  const manifest = JSON.parse(await readFile(path.join(payload, 'plugin.json'), 'utf8'));

  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].compatibility.status, 'compatible');
  assert.equal(scanned[0].nav.path, '/ext/studio3d');
  assert.equal(scanned[0].contributes.panels[0].hotkey, 'Ctrl+Shift+Digit7');
  assert.deepEqual(scanned[0].settings, manifest.contributes.settings);
  assert.ok(scanned[0].entrypoints.web.background);
  assert.ok(scanned[0].icon);
});
