import assert from 'node:assert/strict';
import test from 'node:test';

import { parseClaudeEfforts } from '../../server/src/lib/executors/claude.ts';

test('Claude effort discovery reads choices wrapped onto the next help line', () => {
  const help = [
    '  --effort <level>                      Effort level for the current session',
    '                                        (low, medium, high, xhigh, max, future)',
    '  --exclude-dynamic-system-prompt-sections',
  ].join('\n');

  assert.deepEqual(
    parseClaudeEfforts(help),
    ['low', 'medium', 'high', 'xhigh', 'max', 'future'],
  );
});

test('Claude effort discovery returns no invented levels when help has no choices', () => {
  assert.equal(parseClaudeEfforts('--effort <level>  Effort level'), null);
  assert.equal(parseClaudeEfforts([
    '  --effort <level>  Effort level',
    '  --next-option       Description with (fake, choices)',
  ].join('\n')), null);
  assert.equal(parseClaudeEfforts(''), null);
});
