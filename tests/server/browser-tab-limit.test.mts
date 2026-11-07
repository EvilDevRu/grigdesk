import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_DESCRIPTOR } from '../../shared/browser/browserTool.ts';
import browser, { browserToolResult } from '../../server/src/lib/executors/work-tools/browser.ts';
import { createFactoryBrowserMcp } from '../../server/src/lib/browser/factoryBrowserMcp.ts';

test('Вкладки: descriptor объясняет личный список и автоматическое закрытие после простоя', () => {
  assert.match(BROWSER_DESCRIPTOR.description, /Пустой list/u);
  assert.match(BROWSER_DESCRIPTOR.description, /через 5 минут/u);
  assert.match(BROWSER_DESCRIPTOR.description, /browser_tab_missing/u);
  assert.doesNotMatch(BROWSER_DESCRIPTOR.description, /browser_tab_limit/u);
});

test('Вкладки: ответ о закрытой странице не переносит чужие данные и произвольную подсказку', () => {
  const result = browserToolResult({
    ok: false,
    error: 'browser_tab_missing',
    message: 'Недоверенная подсказка',
    owner: 'other-agent',
  }, 'open');

  assert.deepEqual(result, { ok: false, error: 'browser_tab_missing' });
  assert.deepEqual(browserToolResult({ ok: false, error: 'access_revoked' }, 'open'), {
    ok: false,
    error: 'access_revoked',
  });
});

test('Вкладки: рабочий инструмент сохраняет код закрытой страницы при ответе и исключении', async () => {
  for (const throws of [false, true]) {
    const result = await browser.invoke({
      browserAvailable: () => true,
      browserOwner: 'fixture-owner',
      browserInvoke: async () => {
        if (throws) {
          throw new Error('browser_tab_missing');
        }

        return { ok: false, error: 'browser_tab_missing' };
      },
    }, { action: 'open', url: 'http://fixture.test/' });

    assert.deepEqual(result, { ok: false, error: 'browser_tab_missing' });
  }
});

test('Вкладки: MCP сохраняет код закрытой страницы при ответе и исключении', async () => {
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
          throw new Error('browser_tab_missing');
        }

        return {
          ok: false,
          error: 'browser_tab_missing',
          message: 'Недоверенная подсказка',
        };
      },
    });
    const result = await mcp.invoke({ action: 'open', url: 'http://fixture.test/' });
    const failure = { ok: false, error: 'browser_tab_missing' };

    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, failure);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(failure) }]);
  }
});
