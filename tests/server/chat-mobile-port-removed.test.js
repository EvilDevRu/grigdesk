import assert from 'node:assert/strict';
import test from 'node:test';

import { chatAppFixture } from './helpers/chat-turns.js';

test('CHAT-V1: порт mobileChat не декорируется', async (t) => {
  const fx = await chatAppFixture(t);

  t.after(() => fx.app.close());
  assert.equal(fx.app.hasDecorator('mobileChat'), false);
});
