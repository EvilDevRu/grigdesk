// Свежие лимиты приходят от сервера сами (SSE providers-usage): окно обязано слушать это
// имя, а стор — принимать снимок и не оплачивать его лишним запросом.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { api } from '../../web/src/shared/apiClient.ts';
import { useProvidersStore } from '../../web/src/stores/providers.js';

const SSE_PATH = new URL('../../web/src/composables/useSse.ts', import.meta.url);
const SHELL_PATH = new URL('../../web/src/shared/layout/AppShell.vue', import.meta.url);

test('providers-usage входит в единственную SSE-подписку вкладки и обрабатывается шапкой', async () => {
  const [sse, shell] = await Promise.all([readFile(SSE_PATH, 'utf8'), readFile(SHELL_PATH, 'utf8')]);
  const list = sse.match(/const EVENT_NAMES = \[([\s\S]*?)\](?: as const)?;/);

  assert.ok(list, 'список EVENT_NAMES не найден');
  assert.ok([...list[1].matchAll(/'([a-z-]+)'/g)].some((match) => match[1] === 'providers-usage'));
  assert.match(shell, /name === 'providers-usage'/u);
  assert.match(shell, /prov\.applyUsage\(/u);
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

// Кнопка во всплывашке: один POST на все исполнители, ответ ложится в стор тем же путём,
// что и снимок с фонового тика, а повторный клик во время хода не плодит запросов.
test('принудительная проверка идёт одним POST и не дублируется, пока идёт', async (t) => {
  setActivePinia(createPinia());
  const providers = useProvidersStore();
  const calls = [];
  let finish;

  t.mock.method(api, 'post', (url) => {
    calls.push(url);

    return new Promise((resolve) => {
      finish = resolve;
    });
  });

  const pending = providers.refreshUsage();
  await providers.refreshUsage();
  assert.equal(providers.usageRefreshing, true);
  assert.deepEqual(calls, ['/api/providers/usage/refresh']);

  finish({ usage: { claude: { state: 'ok', bars: [{ key: 'week', pct: 7 }] } } });
  await pending;
  assert.equal(providers.usageRefreshing, false);
  assert.equal(providers.usage.claude.bars[0].pct, 7);
});

test('кнопка проверки стоит в шапке всплывашки и гаснет на паузе вендора', async () => {
  const shell = await readFile(SHELL_PATH, 'utf8');

  assert.match(shell, /data-context="topbar-popover-refresh"/u);
  assert.match(shell, /@click="prov\.refreshUsage\(\)"/u);
  assert.match(shell, /:disabled="!!usagePauseOf\(p\)"/u);
  assert.match(shell, /Следующая проверка \{\{ usagePauseOf\(p\) \}\}/u);
});
