import { loadProductModule } from './helpers/compile-vue.js';
// Свежие лимиты приходят от сервера сами (SSE providers-usage): окно обязано слушать это
// имя, а стор — принимать снимок и не оплачивать его лишним запросом.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { shellContractBrowser } from './helpers/shell-contract-browser.js';
import { subscribedSseNames } from './helpers/sseSubscriptions.js';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { api } from '../../web/src/shared/apiClient.ts';

const { useProvidersStore } = await loadProductModule('src/stores/providers.ts');

const SHELL_PATH = new URL('../../web/src/shared/layout/AppShell.vue', import.meta.url);

test('providers-usage входит в единственную SSE-подписку вкладки и обрабатывается шапкой', async () => {
  const shell = await readFile(SHELL_PATH, 'utf8');

  assert.ok((await subscribedSseNames()).has('providers-usage'));
  assert.match(shell, /name === 'providers-usage'/u);
  assert.match(shell, /prov\.applyUsage\(/u);
  assert.match(shell, /isRecord\(data\) \? data\.autoRefresh/u);
  assert.match(shell, /isRecord\(data\) \? data\.autoRefreshRevision/u);
});

test('снимок с сервера ложится в стор и сдвигает троттл loadUsage', async (t) => {
  setActivePinia(createPinia());

  const providers = useProvidersStore();
  let requests = 0;

  t.mock.method(api, 'get', async () => {
    requests += 1;

    return { usage: { claude: { state: 'ok', bars: [] } } };
  });
  providers.applyUsage({ codex: { state: 'ok', bars: [{ key: 'week', pct: 42 }] } });
  assert.equal(providers.usage.codex.bars[0].pct, 42);

  await providers.loadUsage();
  assert.equal(requests, 0, 'свежий снимок только что пришёл — ходить за ним не надо');

  await providers.loadUsage(true);
  assert.equal(requests, 1, 'force по-прежнему читает');
  assert.equal(providers.usage.claude.state, 'ok');
});

test('мусор вместо снимка стор не принимает', () => {
  setActivePinia(createPinia());

  const providers = useProvidersStore();

  providers.applyUsage({ claude: { state: 'ok', bars: [] } });
  providers.applyUsage(null);
  providers.applyUsage('строка');
  assert.deepEqual(Object.keys(providers.usage), ['claude']);
});

test('W1: ручная проверка передаёт исполнителя и не дублируется', async (t) => {
  setActivePinia(createPinia());

  const providers = useProvidersStore();
  const calls = [];
  let finish;

  t.mock.method(api, 'post', (url, body) => {
    calls.push({ url, body });

    return new Promise((resolve) => {
      finish = resolve;
    });
  });

  const current = {
    autoRefresh: false,
    autoRefreshRevision: 0,
    usage: {
      claude: { state: 'ok', bars: [{ key: 'week', pct: 7 }] },
      codex: { state: 'ok', bars: [{ key: 'week', pct: 22 }] },
    },
  };
  const get = t.mock.method(api, 'get', async () => current);
  const pending = providers.refreshUsage('claude');

  await providers.refreshUsage('claude');
  await providers.loadUsage(true);
  assert.equal(get.mock.callCount(), 0);
  assert.equal(providers.usageRefreshingId, 'claude');
  assert.deepEqual(calls, [{
    url: '/api/providers/usage/refresh', body: { providerId: 'claude' },
  }]);
  finish({
    autoRefresh: false,
    autoRefreshRevision: 0,
    usage: {
      claude: { state: 'ok', bars: [{ key: 'week', pct: 7 }] },
      codex: { state: 'ok', bars: [{ key: 'week', pct: 22 }] },
    },
  });
  await pending;
  assert.equal(providers.usageRefreshing, false);
  assert.equal(providers.usageRefreshingId, '');
  assert.equal(providers.usage.claude.bars[0].pct, 7);
  assert.equal(providers.usage.codex.bars[0].pct, 22);
  assert.equal(providers.usageAutoRefresh, false);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(get.mock.calls[0].arguments[0], '/api/providers/usage?cached=1');
});

test('W1b: отказ адресной проверки виден и освобождает кнопку', async (t) => {
  setActivePinia(createPinia());

  const providers = useProvidersStore();

  providers.applyUsage({ claude: { state: 'ok', bars: [{ key: 'week', pct: 7 }] } });
  t.mock.method(api, 'post', async () => {
    throw new Error('Нет связи с сервером');
  });
  await providers.refreshUsage('claude');
  assert.equal(providers.usageRefreshing, false);
  assert.equal(providers.usageRefreshingId, '');
  assert.match(providers.usageTransport.error, /Нет связи/u);
  assert.equal(providers.usage.claude.bars[0].pct, 7);
});

test('W2: полный SSE со сменой режима обгоняет старый HTTP', async (t) => {
  setActivePinia(createPinia());

  const providers = useProvidersStore();
  let finish;

  t.mock.method(api, 'get', () => new Promise((resolve) => {
    finish = resolve;
  }));

  const pending = providers.loadUsage(true);

  providers.applyUsage({ claude: { state: 'ok', bars: [{ key: 'week', pct: 40 }] } }, false, 2);
  finish({
    autoRefresh: true,
    autoRefreshRevision: 1,
    usage: { claude: { state: 'ok', bars: [] } },
  });
  await pending;
  assert.equal(providers.usageAutoRefresh, false);
  assert.equal(providers.usage.claude.bars[0].pct, 40);
});

test('W3: reconnect во время manual сохраняет карту и выполняет один пассивный resync', async (t) => {
  for (const failed of [false, true]) {
    await t.test(failed ? 'error' : 'success', async (scenario) => {
      setActivePinia(createPinia());

      const providers = useProvidersStore();
      const before = {
        claude: {
          state: 'ok',
          bars: [{ key: 'week', pct: 10 }],
          dataCheckedAt: 1000,
        },
        codex: {
          state: 'ok',
          bars: [{ key: 'week', pct: 20 }],
          dataCheckedAt: 1000,
        },
      };
      const current = {
        ...before,
        claude: {
          ...before.claude,
          bars: [{ key: 'week', pct: 35 }],
          dataCheckedAt: 2000,
        },
      };
      let finish;
      let reject;
      const usageGets = [];

      providers.applyUsage(before, false, 0);
      providers.noteUsageConnection(true);
      scenario.mock.method(api, 'post', () => new Promise((resolve, no) => {
        finish = resolve;
        reject = no;
      }));
      scenario.mock.method(api, 'get', async (url) => {
        if (url.startsWith('/api/providers/usage')) {
          usageGets.push(url);

          return {
            usage: current,
            autoRefresh: false,
            autoRefreshRevision: 0,
          };
        }

        return { providers: [] };
      });

      const pending = providers.refreshUsage('claude');

      providers.noteUsageConnection(false);
      providers.noteUsageConnection(true);
      assert.equal(providers.usage.codex.bars[0].pct, 20);
      assert.equal(providers.usage.codex.dataCheckedAt, 1000);
      assert.equal(usageGets.length, 0);

      if (failed) {
        reject(new Error('Результат не доставлен'));
      } else {
        finish({
          usage: current,
          autoRefresh: false,
          autoRefreshRevision: 0,
        });
      }

      await pending;
      assert.deepEqual(usageGets, ['/api/providers/usage?cached=1']);
      assert.equal(providers.usage.claude.bars[0].pct, 35);
      assert.equal(providers.usage.codex.bars[0].pct, 20);
      assert.equal(providers.usage.codex.dataCheckedAt, 1000);
      assert.equal(providers.usageRefreshing, false);
    });
  }
});

test('кнопка проверки стоит в шапке всплывашки и гаснет на паузе вендора', async (t) => {
  const shell = await readFile(SHELL_PATH, 'utf8');

  assert.match(shell, /data-context="topbar-popover-refresh"/u);
  assert.match(shell, /@click="prov\.refreshUsage\(p\.id\)"/u);
  assert.match(shell,
    /:disabled="!!usagePauseOf\(p\) \|\| prov\.usageRefreshing && prov\.usageRefreshingId !== p\.id"/u);

  const h = await shellContractBrowser(t);

  await h.openProvider();

  const refresh = h.page.locator('[data-context="topbar-popover-refresh"]');

  assert.equal(await refresh.isDisabled(), false);
  await h.setUsage({
    state: 'rate_limited',
    bars: [],
    retryAt: Date.now() + 60000,
  });
  await h.page.locator('.pu-state').filter({ hasText: 'Следующая проверка' }).waitFor();
  assert.equal(await refresh.isDisabled(), true);
});
