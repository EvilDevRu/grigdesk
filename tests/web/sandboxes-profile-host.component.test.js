import assert from 'node:assert/strict';
import test from 'node:test';

import { entry, mountSandboxes, selectStand } from './helpers/sandboxes-layout.js';

test('ссылки карточки используют хост профиля вместо хоста окна GrigDesk', async (t) => {
  const stand = entry({ serviceHost: 'localhost' });
  const { wrapper } = await mountSandboxes(t, { sandboxes: [stand] });

  await selectStand(wrapper, stand.task);

  const links = wrapper.findAll('a').map((item) => item.attributes('href'));

  assert.ok(links.includes(`http://localhost:${stand.fePort}/`));
  assert.ok(links.includes(`http://localhost:${stand.apiPort}/`));
  assert.equal(links.some((href) => href?.startsWith('http://grigdesk.test:')), false);
});
