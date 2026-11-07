import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectGigaCodeFailure
} from '../../server/src/lib/gigacode/failures.ts';

const encode = (...events) => events.map((entry) => JSON.stringify(entry)).join('\n');
const error = (code, phase = 'pre-prompt') => ({
  schema: 'gigacode-acp-v1',
  event: 'run_error',
  code,
  phase,
  message: 'Synthetic failure',
});

test('только подтверждённая host preflight ошибка без activity разрешает failover', () => {
  assert.equal(inspectGigaCodeFailure(encode(error('gigacode_auth_required'))).classification,
    'provider_unavailable');

  for (const activity of [{
        event: 'prompt_started'
      },
      {
        event: 'agent_message_chunk',
        text: 'started'
      },
      {
        event: 'tool_call_update',
        toolCallId: 'one',
        status: 'completed'
      },
      {
        event: 'future_event'
      },
    ]) {
    assert.equal(inspectGigaCodeFailure(encode(activity, error('gigacode_auth_required')))
      .classification, 'unknown');
  }

  assert.equal(inspectGigaCodeFailure(`broken\n${encode(error('gigacode_auth_required'))}`)
    .classification, 'unknown');
});

test('текст tools, новые коды, голые 401/429 не становятся выдуманными сигнатурами', () => {
  for (const code of ['401', '403', '429', 'context_overflow', 'quota_exceeded', 'new']) {
    assert.equal(inspectGigaCodeFailure(encode(error(code))).classification, 'unknown');
  }

  assert.equal(inspectGigaCodeFailure(encode({
    event: 'agent_message_chunk',
    text: '401 quota exceeded token=secret',
  })).failure, null);
});

test('unknown diagnostic очищен, без billing и сбрасывается следующим успехом', () => {
  const failure = inspectGigaCodeFailure(encode({
    ...error('gigacode_wrapper_error', 'prompt'),
    message: '\u001b[31mProvider failure token=secret-value ' + 'x'.repeat(2000),
  })).failure;

  assert.ok(failure.message.length <= 500);
  assert.doesNotMatch(failure.message, /secret-value|\u001b/u);
  assert.equal(inspectGigaCodeFailure(encode(error('new'), {
    event: 'turn_end'
  })).failure, null);
});
