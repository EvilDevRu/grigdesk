import assert from 'node:assert/strict';
import test from 'node:test';

import { isBotTokenShape, maskToken } from '../../server/src/lib/telegram/token.ts';

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';

test('форма Telegram bot token требует id и длинный secret', () => {
  assert.equal(isBotTokenShape(TOKEN), true);
  assert.equal(isBotTokenShape(''), false);
  assert.equal(isBotTokenShape('AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6'), false);
  assert.equal(isBotTokenShape('8123456789:short'), false);
  assert.equal(isBotTokenShape('не токен вовсе'), false);
  assert.equal(isBotTokenShape(`  ${TOKEN}\n`), true);
});

test('маска token оставляет только безопасный хвост', () => {
  const masked = maskToken(TOKEN);
  assert.equal(masked, '…v5u6');
  assert.equal(masked.includes('AAHrEaLLy'), false);
  assert.equal(maskToken(''), '');
});
