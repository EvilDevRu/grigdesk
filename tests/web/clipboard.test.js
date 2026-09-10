import assert from 'node:assert/strict';
import { test } from 'node:test';

import { writeClipboardText } from '../../web/src/shared/clipboard.ts';
import { installUiBrowser } from './helpers/ui-components.js';

test('clipboard helper использует secure API и один очищаемый textarea fallback', async (t) => {
  const browser = await installUiBrowser(t);
  const modernWrites = [];

  Object.defineProperty(browser.navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(value) {
        modernWrites.push(value);
      },
    },
  });
  browser.document.execCommand = () => {
    throw new Error('fallback не должен запускаться при доступном Clipboard API');
  };

  assert.equal(await writeClipboardText('современный путь'), true);
  assert.deepEqual(modernWrites, ['современный путь']);
  assert.equal(Boolean(browser.document.querySelector('textarea')), false);

  browser.navigator.clipboard.writeText = async () => {
    throw new Error('HTTP-контекст');
  };
  const focusTarget = browser.document.createElement('button');
  browser.document.body.appendChild(focusTarget);
  focusTarget.focus();
  let fallbackCalls = 0;

  browser.document.execCommand = (command) => {
    fallbackCalls += 1;
    const area = browser.document.querySelector('textarea');

    assert.equal(command, 'copy');
    assert.equal(area?.value, 'запасной путь');
    assert.equal(area?.readOnly, true);
    assert.equal(area?.getAttribute('aria-hidden'), 'true');

    return true;
  };

  assert.equal(await writeClipboardText('запасной путь'), true);
  assert.equal(fallbackCalls, 1);
  assert.equal(Boolean(browser.document.querySelector('textarea')), false);
  assert.equal(browser.document.activeElement === focusTarget, true);

  browser.document.execCommand = () => {
    throw new Error('copy запрещён');
  };

  assert.equal(await writeClipboardText('ошибка'), false);
  assert.equal(Boolean(browser.document.querySelector('textarea')), false);
});
