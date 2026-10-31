import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserApps } from '../../desktop/src/browser/browserApps.ts';

test('BR04: user Hidden перекрывает system, выбираются только web handlers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-apps-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  for (const dir of ['user', 'system']) {
    await mkdir(path.join(root, dir, 'applications'), { recursive: true });
  }

  const browser = '[Desktop Entry]\nType=Application\nName=Fixture\n'
    + 'Exec=/bin/true %u\nMimeType=x-scheme-handler/http;\n';

  await writeFile(path.join(root, 'system/applications/ff.desktop'), browser);
  await writeFile(path.join(root, 'user/applications/ff.desktop'), browser + 'Hidden=true\n');
  await writeFile(path.join(root, 'system/applications/ch.desktop'), browser);
  await writeFile(path.join(root, 'system/applications/editor.desktop'),
    browser.replace('x-scheme-handler/http', 'text/plain'));

  const apps = createBrowserApps({
    dataHome: path.join(root, 'user'),
    dataDirs: [path.join(root, 'system')],
    manual: [],
  });
  const list = await apps.list();

  assert.equal(list.length, 1);
  assert.equal(list[0]?.name, 'Fixture');
  assert.deepEqual((await apps.resolve(list[0]!.id))?.args,
    ['launch', path.join(root, 'system/applications/ch.desktop')]);
  assert.equal(await apps.resolve('app:forged'), null);
});
