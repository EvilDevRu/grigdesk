import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_TAB_LIMIT_FAILURE } from '../../shared/browser/browserLimits.ts';
import { BROWSER_DESCRIPTOR } from '../../shared/browser/browserTool.ts';
import browser, { browserToolResult } from '../../server/src/lib/executors/work-tools/browser.ts';
import { createFactoryBrowserMcp } from '../../server/src/lib/browser/factoryBrowserMcp.ts';

test('Лимит окна: descriptor объясняет пустой личный список', () => {
  assert.match(BROWSER_DESCRIPTOR.description, /общий лимит окна/u);
  assert.match(BROWSER_DESCRIPTOR.description, /пустой list/u);
});

test('Лимит окна: ответ инструмента не переносит чужие данные и произвольную подсказку', () => {
  const result = browserToolResult({
    ok: false,
    error: 'browser_tab_limit',
    message: 'Недоверенная подсказка',
    owner: 'other-agent',
    tabs: [{ tabId: 'private-tab', url: 'https://private.test/' }],
  }, 'open');

  assert.deepEqual(result, BROWSER_TAB_LIMIT_FAILURE);
  assert.equal(result.scope, 'window');
  assert.equal(result.limit, 20);
  assert.match(result.message, /общий лимит окна: 20 вкладок/u);
  assert.deepEqual(browserToolResult({ ok: false, error: 'access_revoked' }, 'open'), {
    ok: false,
    error: 'access_revoked',
  });
});

test('Лимит окна: рабочий инструмент поясняет отказ при ответе и исключении', async () => {
  for (const throws of [false, true]) {
    const result = await browser.invoke({
      browserAvailable: () => true,
      browserOwner: 'fixture-owner',
      browserInvoke: async () => {
        if (throws) {
          throw new Error('browser_tab_limit');
        }

        return { ok: false, error: 'browser_tab_limit' };
      },
    }, { action: 'open', url: 'http://fixture.test/' });

    assert.deepEqual(result, BROWSER_TAB_LIMIT_FAILURE);
  }
});

test('Лимит окна: MCP возвращает подсказку при ответе и исключении', async () => {
  for (const throws of [false, true]) {
    const mcp = createFactoryBrowserMcp({
      FACTORY_STATE: '/fixture/state',
      FACTORY_RUN_TASK: '77',
      FACTORY_RUN_STAGE: 'CHECK',
      FACTORY_RUN_ID: 'fixture-run',
      FACTORY_RUN_EPOCH: '1',
      FACTORY_STATUS_MODE: 'request',
      FACTORY_STATUS_REQUEST_DIR: '/fixture/state/logs/runs/t77/CHECK/fixture-run/control-requests',
      FACTORY_ROUTE_BROWSER_POLICY: 'allow',
      FACTORY_BROWSER_ENABLED: '1',
      FACTORY_BROWSER_NONCE: 'ab'.repeat(32),
    }, {
      ready: async () => 'grigdesk',
      request: async () => {
        if (throws) {
          throw new Error('browser_tab_limit');
        }

        return {
          ok: false,
          error: 'browser_tab_limit',
          message: 'Недоверенная подсказка',
        };
      },
    });
    const result = await mcp.invoke({ action: 'open', url: 'http://fixture.test/' });

    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, BROWSER_TAB_LIMIT_FAILURE);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(BROWSER_TAB_LIMIT_FAILURE) }]);
  }
});
