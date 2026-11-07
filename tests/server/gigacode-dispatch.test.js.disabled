import assert from 'node:assert/strict';
import test from 'node:test';

import {
  launch
} from '../helpers/gigacode/factory.mjs';

test('настоящий dispatcher не повторяет GigaCode после model activity и сохраняет unknown detail',
  async (t) => {
    const w = await launch(t, {
      promptError: {
        code: -32603,
        message: 'Synthetic unknown diagnostic'
      },
    }, {
      GIGA_TEST_DISPATCH: '1'
    });

    assert.equal(w.result.code, 1, w.result.stderr);
    assert.match(w.result.stdout, /DISPATCH_RUNNER=gigacode/u);
    assert.match(w.result.stdout, /DISPATCH_KIND=unknown/u);
    assert.match(w.result.stdout, /DISPATCH_DETAIL=.*Synthetic unknown diagnostic/u);
    assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 1);
    assert.equal(w.peerCalls, 0);
  });

test('реальный preflight недоступного GigaCode допускает только настроенного secondary', async (t) => {
  const w = await launch(t, {}, {
    GIGA_TEST_DISPATCH: '1',
    GRIGDESK_GIGACODE_HOME: '/no-synthetic-auth-here',
  });

  assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 0);
  assert.equal(w.peerCalls, 1, `${w.result.stdout}\n${w.result.stderr}`);
  assert.match(w.result.stdout, /DISPATCH_RUNNER=codex/u);
});

test('адресный switch останавливает старый GigaCode и исполняет secondary ровно один раз', async (t) => {
  const w = await launch(t, {
    waitForCancel: true,
    stubbornChild: true,
    ignoreTerm: true,
    hangOnClose: true
  }, {
    GIGA_TEST_DISPATCH: '1',
    GIGA_TEST_SWITCH: '1',
  });

  assert.equal(w.result.code, undefined, `${w.result.stdout}\n${w.result.stderr}`);
  assert.match(w.result.stdout, /DISPATCH_RUNNER=codex/u);
  assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 1);
  assert.equal(w.peerCalls, 1);
});

test('positive dispatcher сохраняет пустой effort от resolver до CLI без hidden high', async (t) => {
  const w = await launch(t, {
    mcpCalls: [{
      tool: 'stage_result',
      arguments: {
        result: 'done'
      }
    }],
  }, {
    GIGA_TEST_DISPATCH: '1',
    GIGA_TEST_NO_MODEL_POLICY: '1'
  });

  assert.equal(w.result.code, undefined, `${w.result.stdout}\n${w.result.stderr}`);
  assert.match(w.result.stdout, /DISPATCH_RUNNER=gigacode/u);
  assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 1);
  assert.equal(w.peerCalls, 0);
  assert.doesNotMatch(w.meta, /EFFORT=high/u);
});

test('явный effort без model policy отклонён до prompt, а не стёрт default_policy', async (t) => {
  const w = await launch(t, {}, {
    GIGA_TEST_DISPATCH: '1',
    GIGA_TEST_NO_MODEL_POLICY: '1',
    GIGA_TEST_EFFORT: 'high',
  });

  assert.notEqual(w.result.code, undefined);
  assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 0);
  assert.equal(w.peerCalls, 0);
  assert.match(w.events, /gigacode_effort_unsupported/u);
});
