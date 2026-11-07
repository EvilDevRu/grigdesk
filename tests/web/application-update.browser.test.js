import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { i18nBrowser } from './helpers/i18nBrowser.js';
import { browserDiagnostics } from './helpers/browserDiagnostics.js';
import { scaleClientText } from './helpers/client-browser.mjs';

const applicationUpdate = {
  channel: 'release',
  running: '0.2.0',
  targetVersion: '0.3.0',
  scope: 'desktop',
  notes: { ru: 'Исправление загрузки', en: 'Download fix' },
  checkState: 'available',
  checkedAt: null,
  error: null,
  job: null,
};
const shell = {
  rev: 1,
  profile: null,
  profiles: [],
  status: 'none',
  detail: null,
  localAvailable: false,
  serverApi: null,
  appApi: { major: 0, minor: 1 },
  capabilities: ['appUpdates'],
  applicationUpdate,
};

test('A1/A2 UI-MARK: единый модал и задание в RU/EN, 1280/390, touch и 125%', {
  timeout: 180000,
}, async (t) => {
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'application-update-browser-'));

  t.after(() => fs.rm(artifacts, { recursive: true, force: true }));

  const { browser, origin } = await i18nBrowser(t, { artifacts, shell });

  for (const locale of ['ru-RU', 'en-US']) {
    for (const width of [1280, 390]) {
      for (const density of ['compact', 'comfortable']) {
        await t.test(`${locale}/${width}/${density}`, async () => {
          const context = await browser.newContext({
            locale,
            viewport: { width, height: 900 },
            hasTouch: width === 390,
            deviceScaleFactor: 1.25,
            reducedMotion: 'reduce',
          });
          const page = await context.newPage();
          const diagnose = browserDiagnostics(page, `application-update-${locale}-${width}-${density}`);
          const state = structuredClone(shell);
          const calls = [];
          const pending = new Set();
          const respond = (route) => route.fulfill({ json: state });

          try {
            await diagnose(async () => {
              await page.addInitScript((value) => {
                localStorage.setItem('grigdesk-ui-density', value);
              }, density);
              await page.route('**/__shell/state*', async (route) => {
                const rev = new URL(route.request().url()).searchParams.get('rev');

                if (rev === String(state.rev)) {
                  pending.add(route);

                  return;
                }

                await respond(route);
              });
              await page.route('**/__shell/updates/*', async (route) => {
                const action = new URL(route.request().url()).pathname;

                calls.push(action);

                if (action.endsWith('/prepare')) {
                  state.applicationUpdate.job = {
                    id: 'один-job',
                    version: '0.3.0',
                    scope: 'desktop',
                    stage: 'downloading',
                    downloadedBytes: 50,
                    totalBytes: 100,
                    nextAction: null,
                  };
                }

                state.rev += 1;
                await route.fulfill({ json: { ok: true } });

                for (const poll of pending) {
                  await respond(poll);
                }

                pending.clear();
              });
              await page.goto(origin + '#/chats');

              const mark = page.locator('.app-update-mark');

              await mark.waitFor();
              await mark.locator('.updot').waitFor();
              await scaleClientText(page, 1.25);
              await mark.click();

              const dialog = page.locator('[data-context="application-update-dialog"]');

              await dialog.waitFor();
              assert.match(await dialog.innerText(), /0\.2\.0/);
              assert.match(await dialog.innerText(), /0\.3\.0/);
              assert.match(await dialog.innerText(), /grigdesk-ctl/);
              assert.match(await dialog.innerText(), locale.startsWith('ru')
                ? /Исправление загрузки/ : /Download fix/);
              await page.getByRole('button', { name: locale.startsWith('ru') ? 'Обновить' : 'Update',
                exact: true }).click();
              await page.getByText('50%', { exact: true }).waitFor();
              await page.keyboard.press('Escape');
              await dialog.waitFor({ state: 'hidden' });

              for (const key of ['Enter', 'Space']) {
                await mark.focus();
                await page.keyboard.press(key);
                await dialog.waitFor();
                assert.equal(await page.locator('[data-context="application-update-dialog"]').count(), 1);
                await page.keyboard.press('Escape');
                await dialog.waitFor({ state: 'hidden' });
              }

              assert.equal(calls.filter((url) => url.endsWith('/prepare')).length, 1);
              assert.equal(calls.some((url) => /package-update|restart/.test(url)), false);
              assert.equal(
                await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
                false,
              );
            });
          } finally {
            await context.close();
          }
        });
      }
    }
  }
});

test('UI-REMOTE: браузер без capability не предлагает desktop updater', { timeout: 90000 }, async (t) => {
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'application-no-capability-'));

  t.after(() => fs.rm(artifacts, { recursive: true, force: true }));

  const { browser, origin } = await i18nBrowser(t, {
    artifacts,
    shell: {
      ...shell,
      capabilities: [],
      applicationUpdate: undefined,
    },
  });
  const context = await browser.newContext();

  t.after(() => context.close());

  const page = await context.newPage();

  await page.goto(origin + '#/chats');
  await page.locator('.app-mark').waitFor();
  assert.equal(await page.locator('.app-update-mark').count(), 0);
});
