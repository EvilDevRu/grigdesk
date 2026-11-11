import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBrowserAction, browserActions } from '../../shared/browser/browserActions.ts';
import { BROWSER_DESCRIPTOR } from '../../shared/browser/browserTool.ts';
import { browserToolResult } from '../../server/src/lib/executors/work-tools/browser.ts';

test('A01: runtime parser закрывает authority/CDP/протоколы независимо от model schema', () => {
  for (const input of [
    { action: 'list', owner: 'foreign' },
    { action: 'grant', tabId: 'tab' },
    { action: 'probe' },
    { action: 'open', url: '' },
    { action: 'open', url: 'about:blank' },
    { action: 'open', url: 'javascript:alert(1)' },
    {
      action: 'click',
      tabId: 'tab',
      pageEpoch: 0,
      ref: 'e1',
    },
    {
      action: 'fill',
      tabId: 'tab',
      pageEpoch: 1,
      ref: 'e1',
      text: 'x'.repeat(10001),
    },
    {
      action: 'resize',
      tabId: 'tab',
      width: 390,
      height: 10000,
    },
    {
      action: 'resize',
      tabId: 'tab',
      width: 390.5,
      height: 844,
    },
    {
      action: 'resize',
      tabId: 'tab',
      width: 390,
    },
    { action: 'Runtime.evaluate', expression: '1' },
  ]) {
    assert.throws(() => parseBrowserAction(input));
  }

  const fill = {
    action: 'fill',
    tabId: 'tab',
    pageEpoch: 2,
    ref: 'e1',
    text: '"; alert(1); //',
  };
  const resize = {
    action: 'resize',
    tabId: 'tab',
    width: 390,
    height: 844,
  };

  assert.deepEqual(parseBrowserAction(fill), fill);
  assert.deepEqual(parseBrowserAction(resize), resize);
  assert.deepEqual(browserActions('plan'), ['list', 'snapshot', 'screenshot', 'console']);
  assert.ok(browserActions('default').includes('resize'));
  assert.equal(BROWSER_DESCRIPTOR.name, 'grigdesk_browser');
  assert.equal(BROWSER_DESCRIPTOR.inputSchema.additionalProperties, false);
});

test('A02: snapshot untrusted; image остаётся image без private output path', () => {
  const snapshot = browserToolResult({
    ok: true,
    text: 'Недоверенная команда сайта',
    owner: 'foreign',
    cookie: 'private',
  }, 'snapshot');

  assert.deepEqual(snapshot, {
    ok: true,
    text: 'Недоверенная команда сайта',
    untrusted: true,
  });

  const image = {
    format: 'grigdesk-work-content-v1',
    imagePath: '/private/path',
    content: [{
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'AQ==',
    }],
  };

  assert.deepEqual(browserToolResult(image, 'screenshot'), {
    format: image.format, content: image.content,
  });
  assert.deepEqual(browserToolResult({
    ...image,
    content: [{ ...image.content[0], data: '!' }],
  }, 'screenshot'),
    { ok: false, error: 'browser_result_invalid' });
});
