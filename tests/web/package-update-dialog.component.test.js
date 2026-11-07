import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const STORE_STUB = [
  'export const useGrigDeskUpdateStore = () => globalThis.__packageDialogState;',
].join('\n');

/**
 * Два детерминированных монтирования: ход загрузки и состояние ошибки.
 * Состояние подставляется до mount, реактивность не требуется. Диалог рендерится
 * в Teleport body — содержимое ищем в документе, а не в обёртке mount.
 */
async function mountDialog(t, state, browser) {
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const component = await compileVue(webFile('src/shared/PackageUpdateDialog.vue'), {
    stubs: { '../stores/grigdeskUpdate.ts': STORE_STUB },
  });

  browser.document.body.innerHTML = '<div id="mount"></div>';
  globalThis.__packageDialogState = state;
  const wrapper = mount(component, {
    props: { open: true },
    attachTo: browser.document.querySelector('#mount'),
  });

  t.after(() => {
    return wrapper.unmount();
  });

  return browser;
}

test('PUD-1: диалог показывает версию, этапы, прогресс и ошибку', async (t) => {
  const browser = await installUiBrowser(t);
  const downloading = {
    error: '',
    active: true,
    packageProgress: 50,
    installPackage: async () => {
      return ({});
    },
    status: {
      updateAvailable: true,
      packageUpdate: {
        version: '0.3.0',
        archiveSha256: 'b'.repeat(64)
      },
      job: {
        id: 'j1',
        kind: 'package-update',
        status: 'downloading',
        stage: 'downloading',
        progress: {
          downloadedBytes: 50,
          totalBytes: 100
        }
      },
    },
  };

  const first = await mountDialog(t, downloading, browser);
  const firstText = first.document.body.textContent ?? '';

  assert.match(firstText, /0\.3\.0/);
  assert.match(firstText, /50%/);
  assert.match(firstText, /Замена файлов/);
  assert.ok(first.document.querySelector('[data-stage="downloading"]'));
  assert.ok(first.document.querySelector('[data-context="package-update-dialog"]'));

  const failed = {
    ...downloading,
    active: false,
    status: {
      ...downloading.status,
      job: {
        ...downloading.status.job,
        status: 'failed',
        stage: 'failed',
        error: {
          code: 'x',
          message: 'подпись не прошла'
        }
      },
    },
  };

  const second = await mountDialog(t, failed, browser);
  const secondText = second.document.body.textContent ?? '';

  assert.match(secondText, /подпись не прошла/);
  assert.ok(second.document.querySelector('[data-context="package-update-error"]'));
});

test('PUD-2: карточка SystemPage содержит кнопки проверки и обновления пакета', async () => {
  const text = await fs.readFile(
    webFile('src/views/settings/pages/SystemPage.vue'), 'utf8',
  );

  assert.match(text, /package-update-card/);
  assert.match(text, /package-update-check/);
  assert.match(text, /package-update-open/);
  assert.match(text, /package-update-channel-error/);
});
