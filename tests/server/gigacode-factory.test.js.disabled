import assert from 'node:assert/strict';
import test from 'node:test';

import {
  launch
} from '../helpers/gigacode/factory.mjs';

for (const verdict of [{
      result: 'done',
      comment: 'synthetic done'
    },
    {
      result: 'skipped',
      comment: 'synthetic skipped'
    },
    {
      result: 'failed',
      failureOwner: 'human',
      findings: ['access=Нужен доступ']
    },
    {
      result: 'failed',
      failureOwner: 'build',
      findings: ['build=Сборка сломана']
    },
    {
      result: 'done',
      deferredFindings: ['later=Отдельное улучшение'],
      reviewed: ['src/fixture.ts']
    },
  ]) {
  test(`настоящий launcher принимает typed status ${JSON.stringify(verdict)}`, async (t) => {
    const w = await launch(t, {
      mcpCalls: [{
        server: 'factory-status',
        tool: 'stage_result',
        arguments: verdict
      }],
    });

    assert.equal(w.result.code, undefined, `${w.result.stdout}\n${w.result.stderr}`);
    assert.match(w.result.stdout, new RegExp(`RESULT=${verdict.result}`, 'u'));
    assert.match(w.events, /"event":"turn_end"/u);
    assert.equal(w.requests.filter((entry) => entry.message?.method === 'session/prompt').length,
      1);
    assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 1);

    const startup = w.observed.find((entry) => entry.kind === 'startup');

    assert.ok(startup.argv.includes('--acp'));
    assert.ok(startup.argv.some((arg) => arg.startsWith('--exclude-tools=agent,skill')));
    assert.doesNotMatch(startup.argv.join(' '),
      /Синтетический prompt|synthetic-native-fixture-token/u);
    assert.equal(startup.sensitiveEnvPresent, false);

    if (verdict.failureOwner) {
      assert.equal(w.verdict.owner, verdict.failureOwner);
      assert.equal(w.verdict.findings[0].id, verdict.findings[0].split('=')[0]);
    }

    if (verdict.deferredFindings) {
      assert.equal(w.verdict.findings[0].severity, 'deferred');
      assert.deepEqual(w.verdict.reviewed, verdict.reviewed);
    }

    assert.doesNotMatch(w.events + w.meta,
      /synthetic-native-fixture-token|synthetic-status-secret/u);
  });
}

for (const invalid of [{
      result: 'human'
    },
    {
      result: 'done',
      task: 999
    },
    {
      result: 'failed',
      failureOwner: 'invented',
      findings: ['x=one']
    },
    {
      result: 'failed',
      failureOwner: 'build',
      findings: ['same=one', 'same=two']
    },
    {
      result: 'failed',
      failureOwner: 'build',
      findings: ['broken']
    },
    {
      result: 'done',
      nextStage: true,
      stageClosed: ['first'],
      stageSummary: 'illegal'
    },
  ]) {
  test(`недействительный status не завершает стадию ${JSON.stringify(invalid)}`, async (t) => {
    const w = await launch(t, {
      mcpCalls: [{
        server: 'factory-status',
        tool: 'stage_result',
        arguments: invalid
      }],
    });

    assert.equal(w.result.code, 76, `${w.result.stdout}\n${w.result.stderr}`);
    assert.doesNotMatch(w.result.stdout, /RESULT=(done|failed|skipped)/u);
    assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 1);
    assert.equal(w.verdict, null);
  });
}

test('текст «готово» без принятого статуса даёт missing_status', async (t) => {
  const w = await launch(t, {});

  assert.equal(w.result.code, 76, `${w.result.stdout}\n${w.result.stderr}`);
  assert.doesNotMatch(w.result.stdout, /RESULT=done/u);
});

test('unknown terminal без billing сохраняет diagnostic в immutable launcher meta', async (t) => {
  const w = await launch(t, {
    promptError: {
      code: -32603,
      message: 'Synthetic provider failure'
    }
  });

  assert.notEqual(w.result.code, undefined);
  assert.match(w.meta, /FAILURE_MESSAGE=.*Synthetic provider failure/u);
  assert.doesNotMatch(w.meta, /^(?:TOKENS_(?:IN|OUT|CACHE_READ)|COST_USD)=/mu);
  assert.match(w.meta, /^USAGE_COMPLETE=0$/mu);
});

test('launcher не сохраняет credential, разбитый между chunks, в journal и last.md', async (t) => {
  const w = await launch(t, {
    updates: ['synthetic-native-', 'fixture-token'].map((text) => ({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    })),
    mcpCalls: [{
      tool: 'stage_result',
      arguments: { result: 'done' },
    }],
  });

  assert.equal(w.result.code, undefined, `${w.result.stdout}\n${w.result.stderr}`);
  assert.doesNotMatch(w.events + w.meta + w.last, /synthetic-native-fixture-token/u);
  assert.equal(w.last, '[скрыто]');
});

test('корень, раскрывающий весь Factory state, отклонён до prompt', async (t) => {
  const w = await launch(t, {
    nestedState: true,
    mcpCalls: [{ tool: 'stage_result', arguments: { result: 'done' } }],
  });

  assert.notEqual(w.result.code, undefined);
  assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 0);
  assert.match(w.meta, /FAILURE_MESSAGE=.*Factory state/u);
});

test('обновлённый CLI проходит настоящий resolver и сохраняет версию попытки', async (t) => {
  const w = await launch(t, {
    cliVersion: '26.8.0',
    packageVersion: '0.14.0',
    mcpCalls: [{ tool: 'stage_result', arguments: { result: 'done' } }],
  }, {
    GIGA_TEST_DISPATCH: '1',
    GIGA_TEST_NO_MODEL_POLICY: '1',
  });

  assert.equal(w.result.code, undefined, `${w.result.stdout}\n${w.result.stderr}`);
  assert.equal(w.peerCalls, 0);
  assert.match(w.result.stdout, /DISPATCH_RUNNER=gigacode/u);
  assert.match(w.meta, /^CLI_VERSION=26\.8\.0$/mu);
  assert.equal(JSON.parse(w.events.split('\n').find((line) => line.includes('"event":"run_start"')))
    .cliVersion, '26.8.0');
});

test('прогресс не является status; неподдерживаемые ключи и ROUTE_BY=human отклонены', async (t) => {
  const w = await launch(t, {
    mcpCalls: [{
        tool: 'stage_progress',
        arguments: {
          updates: [{
            key: 'ROUTE_BY',
            value: 'human'
          }]
        }
      },
      {
        tool: 'stage_progress',
        arguments: {
          updates: [{
            key: 'UNTRUSTED',
            value: 'done'
          }]
        }
      },
      {
        tool: 'stage_progress',
        arguments: {
          updates: [{
            key: 'PLANS',
            value: 'done'
          }]
        }
      },
      {
        tool: 'stage_result',
        arguments: {
          result: 'done',
          comment: 'first wins'
        }
      },
      {
        tool: 'stage_result',
        arguments: {
          result: 'skipped',
          comment: 'stale duplicate'
        }
      },
    ],
  });

  assert.equal(w.result.code, undefined, w.result.stderr);
  assert.match(w.result.stdout, /RESULT=done/u);
  assert.match(w.result.stdout, /COMMENT=first wins/u);
  assert.match(w.result.stdout, /PLANS=done/u);
  assert.match(w.result.stdout, /ROUTE_BY=\s*\n/u);
  assert.match(w.result.stdout, /UNTRUSTED=\s*\n/u);
});

test('ведущий передаёт границу этапа с findings, closes и summary через штатный writer', async (t) => {
  const w = await launch(t, {
    mcpCalls: [{
      tool: 'stage_result',
      arguments: {
        result: 'failed',
        failureOwner: 'build',
        findings: ['second=Следующий этап'],
        nextStage: true,
        stageClosed: ['first'],
        stageSummary: 'Первый этап принят',
        findingAnchors: ['second=src/fixture.ts'],
        reviewed: ['src/fixture.ts'],
      }
    }],
  }, {
    FACTORY_LOOP_ROLE: 'lead'
  });

  assert.equal(w.result.code, undefined, w.result.stderr);
  assert.deepEqual(w.verdict.stage, {
    kind: 'next',
    closes: ['first'],
    summary: 'Первый этап принят'
  });
  assert.equal(w.verdict.findings[0].anchor, 'src/fixture.ts');
});

test('неведущий не повышает loop role через аргументы инструмента', async (t) => {
  const w = await launch(t, {
    mcpCalls: [{
      tool: 'stage_result',
      arguments: {
        result: 'failed',
        failureOwner: 'build',
        findings: ['next=Next'],
        nextStage: true,
        stageClosed: ['first'],
        stageSummary: 'Done',
        loopRole: 'lead',
      }
    }],
  });

  assert.equal(w.result.code, 76);
  assert.equal(w.verdict, null);
});

for (const [result, role] of [
    ['failed', 'worker'],
    ['done', 'lead']
  ]) {
  test(`граница этапа отклоняется с точной формой payload: ${result}/${role}`, async (t) => {
    const w = await launch(t, {
      mcpCalls: [{
        tool: 'stage_result',
        arguments: {
          result,
          ...(result === 'failed' ? {
            failureOwner: 'build',
            findings: ['next=Next']
          } : {}),
          nextStage: true,
          stageClosed: ['first'],
          stageSummary: 'Done',
        }
      }],
    }, {
      FACTORY_LOOP_ROLE: role
    });

    assert.equal(w.result.code, 76);
    assert.equal(w.verdict, null);
    assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 1);
  });
}

test('Factory не разрешает неизвестный permission и не ждёт человека', async (t) => {
  const w = await launch(t, {
    permission: {},
    mcpCalls: [{
      tool: 'stage_result',
      arguments: {
        result: 'done'
      }
    }],
  });

  assert.equal(w.result.code, undefined, w.result.stderr);

  const answer = w.requests.find((entry) => entry.kind === 'permission_response');

  assert.equal(answer.message.result.outcome.optionId, 'reject-once');
});

test('Factory без discovery обязательного MCP не отправляет prompt', async (t) => {
  const w = await launch(t, {
    discoverMcp: false
  }, {
    GIGA_TEST_TIMEOUT: '15'
  });

  assert.equal(w.result.code, 4);
  assert.match(w.events, /gigacode_mcp_unavailable/u);
  assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 0);
});

for (const [requirement, level, count] of [
    ['single:1:forbid', 'native', 1],
    ['parallel:2:forbid', 'unavailable', 0],
    ['parallel:2:allow-single', 'degraded', 1],
  ]) {
  test(`execution planner ограничивает реальный запуск GigaCode: ${requirement}`, async (t) => {
    const [mode, max, degrade] = requirement.split(':');
    const w = await launch(t, {
      mcpCalls: [{
        tool: 'stage_result',
        arguments: {
          result: 'done'
        }
      }],
    }, {
      GIGA_TEST_PLAN: '1',
      FACTORY_ROUTE_FANOUT_MODE: mode,
      FACTORY_ROUTE_FANOUT_MAX: max,
      FACTORY_ROUTE_FANOUT_DEGRADE: degrade,
    });

    assert.match(w.result.stdout, new RegExp(`PLAN_LEVEL=${level}`, 'u'));
    assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, count);
    assert.equal(w.result.code, count === 0 ? 79 : undefined);

    if (level === 'degraded') {
      assert.match(w.result.stdout, /PLAN_DEGRADED=fanout/u);
    }
  });
}

test('timeout Factory завершает своё дерево и не принимает ложный успех', async (t) => {
  const w = await launch(t, {
    waitForCancel: true,
    stubbornChild: true,
    ignoreTerm: true,
    hangOnClose: true
  }, {
    GIGA_TEST_TIMEOUT: '1',
  });

  assert.equal(w.result.code, 124, `${w.result.stdout}\n${w.result.stderr}`);
  assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 1);
  assert.doesNotMatch(w.result.stdout, /RESULT=done/u);
});

for (const extraEnv of [{
      FACTORY_ROUTE_FILESYSTEM_POLICY: 'unknown'
    },
    {
      GIGA_TEST_EFFORT: 'high'
    },
    {
      GRIGDESK_GIGACODE_HOME: '/no-synthetic-auth-here'
    },
  ]) {
  test(`отказ конфигурации до prompt ${JSON.stringify(extraEnv)}`, async (t) => {
    const w = await launch(t, {}, extraEnv);

    assert.notEqual(w.result.code, undefined);
    assert.doesNotMatch(w.events, /"event":"prompt_started"/u);
    assert.equal(w.requests.filter((entry) => entry.message?.method === 'session/prompt').length,
      0);
    assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 0);
  });
}

test('Factory wrapper защищает исходник и разрешает отчёт внутри той же kernel границы', async (t) => {
  const w = await launch(t, {
    filesystemProbe: true,
    mcpCalls: [{
      tool: 'stage_result',
      arguments: {
        result: 'done'
      }
    }],
  });

  assert.equal(w.result.code, undefined, w.result.stderr);
  assert.deepEqual(w.observed.filter((entry) => entry.kind === 'filesystem')
    .map((entry) => entry.outcome), ['EROFS', 'written']);
});

test('потеря status MCP после discovery не становится успешной стадией', async (t) => {
  const w = await launch(t, {
    mcpDisconnect: true,
    mcpCalls: [{
      tool: 'stage_result',
      arguments: {
        result: 'done'
      }
    }],
  });

  assert.equal(w.result.code, 76);
  assert.equal(w.observed.filter((entry) => entry.method === 'session/prompt').length, 1);
  assert.doesNotMatch(w.result.stdout, /RESULT=done/u);
});

test('progress-only не завершает стадию', async (t) => {
  const w = await launch(t, {
    mcpCalls: [{
      tool: 'stage_progress',
      arguments: {
        updates: [{
          key: 'PLANS',
          value: 'done'
        }]
      }
    }],
  });

  assert.equal(w.result.code, 76);
  assert.match(w.result.stdout, /PLANS=done/u);
  assert.doesNotMatch(w.result.stdout, /RESULT=done/u);
});

test('typed verdict сохраняет все findings, summary и anchors без урезания', async (t) => {
  const w = await launch(t, {
    mcpCalls: [{
      tool: 'stage_result',
      arguments: {
        result: 'failed',
        failureOwner: 'build',
        findings: ['first=Первое замечание', 'second=Второе замечание'],
        findingAnchors: ['first=src/one.ts', 'second=src/two.ts'],
        reviewed: ['src/one.ts', 'src/two.ts'],
      }
    }],
  });

  assert.equal(w.result.code, undefined, w.result.stderr);
  assert.deepEqual(w.verdict, {
    owner: 'build',
    findings: [{
        id: 'first',
        summary: 'Первое замечание',
        anchor: 'src/one.ts'
      },
      {
        id: 'second',
        summary: 'Второе замечание',
        anchor: 'src/two.ts'
      },
    ],
    reviewed: ['src/one.ts', 'src/two.ts'],
  });
});

test('fanout_count читает опубликованный wrapper JSON, update-only Agent считается один раз', async (
  t) => {
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'synthetic-agent',
      status: 'completed',
      _meta: {
        toolName: 'agent'
      },
    };
    const w = await launch(t, {
      updates: [update, update, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Описание инструмента agent не является вызовом'
        }
      }],
      mcpCalls: [{
        tool: 'stage_result',
        arguments: {
          result: 'done'
        }
      }],
    });

    assert.equal(w.result.code, undefined, w.result.stderr);
    assert.match(w.result.stdout, /FANOUT=1/u);
  });
