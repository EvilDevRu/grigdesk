import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { API_VERSION } from '../../shared/client/apiVersion.ts';
import { createClientRuntime } from '../../desktop/src/clientRuntime.ts';
import { versionFailure } from '../../desktop/src/pipe/versionGate.ts';
import { sourceMenu, launchMenu, menuTitle } from '../cli/helpers/menuFixture.mts';
import { i18nBrowser } from '../web/helpers/i18nBrowser.js';
import { browserDiagnostics } from '../web/helpers/browserDiagnostics.js';
import { card, preparation } from '../web/helpers/providerInstallFixture.js';

for (const localAvailable of [false, true]) {
  test(`BASE-REMOTE: remote переживает close/start при localAvailable=${localAvailable}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'update-preservation-'));
    const settingsPath = path.join(root, 'settings.json');
    const remote = {
      id: 'remote-fixture',
      name: 'Удалённая фикстура',
      kind: 'remote',
      address: 'https://offline.example:443',
      fp: '1'.repeat(64),
      port: 47923,
      createdAt: 0,
    };
    let settings = {
      version: 2,
      profiles: [remote],
      selected: remote.id,
      window: {
        width: 900,
        height: 700,
        maximized: false,
      },
    };
    let preparations = 0;

    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(settingsPath, JSON.stringify(settings));

    for (let boot = 0; boot < 2; boot += 1) {
      const runtime = createClientRuntime({
        settings,
        save: () => fs.writeFile(settingsPath, JSON.stringify(settings)),
        uiDir: root,
        secret: 'synthetic-update-secret',
        identity: { load: async () => {
          throw new Error('Личность фикстуры недоступна');
        } },
        identityDirectory: root,
        localAvailable: () => localAvailable,
        localAddress: () => 'http://127.0.0.1:1',
        windowKey: async () => '',
        prepareLocal: async () => {
          preparations += 1;
        },
        onOrigin: () => {},
        navigate: async () => {},
      });

      t.after(() => runtime.close());
      await runtime.start();
      await runtime.shell.connect(remote.id);
      assert.equal(runtime.shell.state().profile?.id, remote.id);
      assert.equal(runtime.shell.state().status, 'unpaired');
      assert.equal(settings.selected, remote.id);
      assert.equal(settings.profiles[0].fp, remote.fp);
      assert.equal(preparations, 0, 'remote не подготавливает и не запускает local');
      await runtime.close();
      settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    }
  });
}

test('BASE-API: прежний клиент 0.1 сохраняет gate и WebSocket 101 без updater capability', () => {
  assert.deepEqual(API_VERSION, { major: 0, minor: 1 });

  for (const [header, expected] of [
    ['0.1', null],
    ['0.2', null],
    ['1.0', 'client_upgrade_required'],
    ['0.0', 'server_upgrade_required'],
    [undefined, 'server_upgrade_required'],
  ]) {
    assert.equal(versionFailure(API_VERSION, header), expected);
  }

  assert.equal(versionFailure(API_VERSION, undefined, 101), null);
});

test('BASE-SOURCE: меню исходников сохраняет сборку и разработку без installed update', async (t) => {
  const box = await sourceMenu(t);
  const session = launchMenu(t, box);

  await session.wait(menuTitle);
  assert.match(session.output(), /Сборка/u);
  assert.match(session.output(), /Разработка/u);
  assert.equal(box.calls().some((call) => /maintenance|update|npm/u.test(call)), false);
  session.write('\x1b');
  assert.equal((await session.done).code, 0);
});

test('BASE-PROVIDER: точка и действие исполнителя работают в настоящей оболочке', async (t) => {
  const provider = {
    ...card,
    updateAvailable: true,
    latest: '1.1.0',
  };
  const { browser, origin } = await i18nBrowser(t, {
    responses: { '/api/providers': { providers: [provider], models: [] } },
  });
  const page = await browser.newPage({ locale: 'ru-RU' });
  let preparations = 0;
  const diagnose = browserDiagnostics(page, 'base-provider');

  await diagnose(async () => {
    await page.route('**/api/providers/claude/update/prepare', async (route) => {
      preparations += 1;
      await route.fulfill({ json: { preparation: preparation() } });
    });
    await page.goto(origin + '#/chats');
    await page.locator('[data-context="provider-status"] .updot').waitFor();
    await page.locator('[data-context="provider-status"]').click();
    await page.locator('[data-context="topbar-popover-update"]').click();
    await page.locator('[data-role="provider-install-dialog"]').waitFor();
    assert.equal(preparations, 1, 'действие идёт в прежнюю подготовку установки исполнителя');
    assert.equal(await page.locator('[data-context="provider-status"] .updot').count(), 1);
  });
});
