import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

import { toolRun, waitFor } from './tool-window-fixture.mjs';
import { browserSite } from './browser-site.mjs';
import { waitForGuest } from './browser-guest.mjs';

test('BR-E01: живой сайт сохраняет форму; общий модал получает ввод поверх guest', async (t) => {
  const f = await toolRun(t);
  const site = await browserSite();

  t.after(() => site.close());
  await f.page.getByRole('link', { name: 'Браузер', exact: true }).click();

  const address = f.page.getByRole('textbox', { name: 'Адрес', exact: true });

  await address.fill(site.url);
  await address.press('Enter');

  const guest = await waitForGuest(f.app, site.url);

  await guest.evaluate(`document.querySelector('input').value = 'сохранить'`);
  await f.page.getByRole('link', { name: 'Чаты', exact: true }).click();
  await waitFor(async () => !await guest.isVisible());
  await f.page.getByRole('link', { name: 'Браузер', exact: true }).click();
  await waitFor(() => guest.isVisible());
  assert.equal(await guest.evaluate(`document.querySelector('input').value`), 'сохранить');
  await f.page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await f.page.getByRole('dialog').waitFor();
  await waitFor(async () => !await guest.isVisible());

  const search = f.page.getByRole('searchbox', { name: /Поиск/u });

  await search.fill('браузер');
  assert.equal(await search.inputValue(), 'браузер');
  await f.page.screenshot({ path: path.join(process.env.GRIGDESK_E2E_ARTIFACTS, 'browser-modal.png') });
  assert.deepEqual(f.errors, []);
});

test('BR-E02: настоящий isolated snapshot/fill/click/JPEG, dedupe и human revoke', async (t) => {
  const site = await browserSite();

  t.after(() => site.close());

  const f = await toolRun(t, {
    configure: async (context) => {
      await context.route('**/api/browser/hosts', (route) => route.fulfill({
        status: 409, json: { error: 'browser_host_conflict' },
      }));
    },
  });

  await f.page.getByRole('link', { name: 'Браузер', exact: true }).click();
  await f.page.evaluate(async () => {
    await window.grigdeskBrowser.invoke({ operation: 'preferences', value: {
      open: 'internal',
      external: 'system',
      agents: true,
    } });
  });
  await waitFor(() => f.page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

    return pinia._s.get('browser')?.hostStatus.phase === 'conflict';
  }));

  const owner = JSON.stringify(['chat', null, 'synthetic-native', null]);
  let sequence = 0;

  /**
   * Trusted тестовый caller посылает фиксированный action через настоящий preload.
   * Broker authorization не подменяется этим helper: она отдельно покрыта API/authority RED.
   */
  async function execute(input, grantEpoch = 0, requestId = `request-${++sequence}`) {
    return f.page.evaluate(async (value) => {
      await window.grigdeskBrowser.invoke({
        operation: 'host-start',
        hostId: 'synthetic-host',
        hostEpoch: 1,
        leaseUntil: Date.now() + 15000,
      });

      return window.grigdeskBrowser.invoke({ operation: 'execute', command: {
        ...value.input,
        requestId: value.requestId,
        owner: value.owner,
        grantEpoch: value.grantEpoch,
        hostId: 'synthetic-host',
        hostEpoch: 1,
        deadline: Date.now() + 15000,
      } });
    }, {
      input,
      owner,
      grantEpoch,
      requestId
    });
  }

  const opened = await execute({ action: 'open', url: site.url });

  assert.equal(opened.ok, true);

  const guest = await waitForGuest(f.app, site.url);
  const shot = await execute({ action: 'snapshot', tabId: opened.tabId }, opened.grantEpoch);
  const input = shot.elements.find((item) => item.tag === 'input');
  const submit = shot.elements.find((item) => item.tag === 'button');

  assert.equal(shot.untrusted, true);
  assert.ok(input);
  assert.ok(submit);

  const filled = await execute({
    action: 'fill',
    tabId: opened.tabId,
    pageEpoch: shot.pageEpoch,
    ref: input.ref,
    text: 'настоящий ввод',
  }, opened.grantEpoch);

  assert.equal(filled.ok, true);
  assert.equal(await guest.evaluate(`document.querySelector('input').value`), 'настоящий ввод');

  const click = {
    action: 'click',
    tabId: opened.tabId,
    pageEpoch: shot.pageEpoch,
    ref: submit.ref
  };

  await execute(click, opened.grantEpoch, 'same-click');
  await execute(click, opened.grantEpoch, 'same-click');
  assert.equal(await guest.evaluate(`document.querySelector('#count').value`), '1');

  const jpeg = await execute({ action: 'screenshot', tabId: opened.tabId }, opened.grantEpoch);

  assert.equal(jpeg.format, 'grigdesk-work-content-v1');
  assert.equal(jpeg.content[0].mimeType, 'image/jpeg');
  assert.ok(Buffer.from(jpeg.content[0].data, 'base64').length > 100);
  await writeFile(path.join(process.env.GRIGDESK_E2E_ARTIFACTS, 'browser-guest.jpg'),
    Buffer.from(jpeg.content[0].data, 'base64'));

  let consoleResult;

  await waitFor(async () => {
    consoleResult = await execute({ action: 'console', tabId: opened.tabId }, opened.grantEpoch);

    return JSON.stringify(consoleResult.console).includes('browser-fixture-error');
  });
  assert.equal(consoleResult.untrusted, true);
  await f.page.evaluate((tabId) => window.grigdeskBrowser.invoke({ operation: 'revoke', tabId }),
    opened.tabId);

  const denied = await execute(click, opened.grantEpoch);

  assert.equal(denied.ok, false);
  assert.equal(await guest.evaluate(`document.querySelector('#count').value`), '1');
  assert.deepEqual(f.errors, []);
});

test('BR-E03: human guest отделён от UI cookie и не читает local shell pipe', async (t) => {
  const site = await browserSite();

  t.after(() => site.close());

  const f = await toolRun(t);

  await f.page.evaluate(() => {
    document.cookie = 'uiOnlyFixture=private; SameSite=Lax';
  });
  await f.page.getByRole('link', { name: 'Браузер', exact: true }).click();
  await f.page.getByRole('textbox', { name: 'Адрес', exact: true }).fill(site.url);
  await f.page.getByRole('textbox', { name: 'Адрес', exact: true }).press('Enter');

  const guest = await waitForGuest(f.app, site.url);
  const cookie = await guest.evaluate('document.cookie');
  const uiOrigin = new URL(f.page.url()).origin;

  assert.equal(cookie.includes('uiOnlyFixture'), false);
  assert.equal(cookie.includes('fixtureBrowser=one'), true);
  assert.equal(await guest.evaluate('typeof window.grigdeskBrowser'), 'undefined');

  const result = await guest.evaluate(`fetch(${JSON.stringify(uiOrigin + '/__shell/state')})
    .then(r => r.ok).catch(() => false)`);

  assert.equal(result, false);
  assert.deepEqual(f.errors, []);
});
