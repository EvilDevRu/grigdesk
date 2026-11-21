import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { goCandidate } from '../helpers/goCandidate.mts';
import { awaitCandidateRequest } from '../helpers/goCandidateHandshake.mts';
import { startHttpFixture } from './helpers/httpFixture.mts';
import type { FixtureHandler } from './helpers/httpFixture.mts';
import { childEnv, runProcess, syntheticHome } from './helpers/processFixture.mts';

const executable = goCandidate('pipeline');
const attempt = 'a_' + 'a'.repeat(32);
const token = 'fixture-token';

/**
 * Направляет кандидата только на локальный HTTP-приёмник с подставным ключом.
 * PATH остаётся пустым при запуске Go-файла и чтении его результата.
 */
async function fixtureEnv(baseUrl: string) {
  const { home } = await syntheticHome();

  return childEnv(home, {
    PATH: '',
    GRIGDESK_URL: baseUrl,
    GRIGDESK_TOKEN: token,
  });
}

test('PIPE-GO-PRELUDE-TERMINAL: trusted terminal остаётся доступен без cursor', async (t) => {
  const fixture = await startHttpFixture(t, (request, response) => {
    if (request.url.endsWith('/mobile-state')) {
      response.end('{"identity":null,"running":false}');

      return;
    }
    if (request.url.endsWith('/prelude-state')) {
      response.end(JSON.stringify({
        identity: null,
        running: false,
        attempt,
        profile: 'demo',
        terminal: 'abandoned',
      }));

      return;
    }

    response.end(JSON.stringify({
      attempt,
      profile: 'demo',
      daemonAlive: false,
      readOnly: false,
      result: 'completed',
      registry: { RESULT: 'completed' },
    }));
  });
  const env = await fixtureEnv(fixture.baseUrl);
  const result = await runProcess(t, executable, ['wait', '7', attempt, '1000'], { env });

  assert.equal(result.code, 0, result.stderr.toString());
  assert.deepEqual(JSON.parse(result.stdout.toString()), {
    outcome: 'terminal',
    task: '7',
    attempt,
    terminal: 'abandoned',
    identity: null,
  });
  assert.deepEqual(fixture.requests.map(({ url }) => url), [
    '/api/tasks/7/mobile-state', '/api/tasks/7/prelude-state', '/api/tasks/7', '/api/tasks/7/prelude-state',
  ]);
});

test('PIPE-GO-DEADLINE: общий срок закрывает зависший HTTP и оставляет JSON', async (t) => {
  const fixture = await startHttpFixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"partial":');
  });
  const env = await fixtureEnv(fixture.baseUrl);
  const result = await runProcess(t, executable, ['wait', '7', attempt, '120'], { env });

  assert.equal(result.code, 124, result.stderr.toString());
  assert.deepEqual(JSON.parse(result.stdout.toString()), {
    outcome: 'timeout',
    task: '7',
    attempt,
  });
  assert.equal(result.stderr.length, 0);
  assert.equal(fixture.requests.length, 1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`PIPE-GO-CANCEL: ${signal} закрывает чтение ответа POST`, async (t) => {
    let markReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      markReceived = resolve;
    });
    const fixture = await startHttpFixture(t, (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"partial":');
      markReceived();
    });
    const env = await fixtureEnv(fixture.baseUrl);
    const args = ['arbiter-stop', '7'];
    const child = spawn(executable, args, { env });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    t.after(() => child.kill('SIGKILL'));
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => undefined);
    child.stdin.end('{"operationId":"fixture"}');
    await awaitCandidateRequest(received, exited);
    assert.equal(child.kill(signal), true);

    const result = await exited;

    assert.deepEqual(result, { code: 130, signal: null });
    assert.equal(Buffer.concat(stdout).length, 0);
    assert.equal(Buffer.concat(stderr).toString(), 'Команда pipeline отменена.\n');
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]!.method, 'POST');
  });
}

/**
 * Запускает один процесс с JSON-вводом на том же независимом приёмнике.
 * Байты запроса и коды фиксирует HTTP-фикстура, а не библиотечная подмена команды.
 */
async function pipelineFixture(t: test.TestContext, handler: FixtureHandler) {
  const fixture = await startHttpFixture(t, handler);
  const env = await fixtureEnv(fixture.baseUrl);

  return {
    ...fixture,
    /**
     * Ведёт stdout и stderr раздельно, передавая каждый ввод через stdin процесса.
     * Возвращает также код завершения для проверок частичных результатов.
     */
    async run(argv: readonly string[], value?: unknown) {
      const input = typeof value === 'string' ? value : JSON.stringify(value);
      const result = await runProcess(t, executable, argv, { env, input });

      return {
        code: result.code,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
  };
}

export const mobile = {

  profile: 'demo',
  attempt: 'a_' + 'a'.repeat(32),
  node: 'gate_plan',
  state: 'paused',

  stop: null,
  sequence: 8,
  headEventHash: 'b'.repeat(64),
  orchPid: 0,
  terminal: null,

};

test('PIPE-CONTROL: exact снимок и многострочный текст передаются без изменения', async (t) => {
  const fx = await pipelineFixture(t, (_seen, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end('{"ok":true,"resumed":true}');
  });
  const cases = [
    [['stop', '7'], {
        expectedMobile: mobile
      }, '/api/tasks/7/stop'],
    [['resume', '7'], {
        expectedMobile: mobile
      }, '/api/tasks/7/resume'],
    [['goto', '7', 'PLAN'], {
        expectedMobile: mobile, comment: 'Причина\nПолный текст'
      }, '/api/tasks/7/stage/PLAN/running'],
    [['gate', '7', 'GATE_PLAN', 'reject'], {
        expectedMobile: mobile, comment: 'Доработать\nпункт 2'
      }, '/api/tasks/7/gate/GATE_PLAN/reject'],
  ] as const;

  for (const [argv, input, path] of cases) {
    const result = await fx.run(argv, input);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(fx.requests.at(-1)?.url, path);
    assert.deepEqual(JSON.parse(fx.requests.at(-1)!.body.toString()), input);
  }

  const count = fx.requests.length;

  for (const input of [{}, {
      expectedMobile: {
        attempt: mobile.attempt
      }
    }, {
      expectedMobile: {
        ...mobile, extra: true
      }
    }]) {
    assert.equal((await fx.run(['resume', '7'], input)).code, 2);
  }

  assert.equal((await fx.run(['goto', '7', 'PLAN'], {
    expectedMobile: mobile, comment: ''
  })).code, 2);
  assert.equal(fx.requests.length, count);
});

test('PIPE-SETTINGS: точная связка и пустой effort сохраняются без подбора', async (t) => {
  const identity = {
    task: '7',
    profile: 'demo',
    attempt: 'a_' + 'a'.repeat(32),
    node: 'plan',
    stage: 'PLAN',
  };
  const input = {
    identity,
    expectedRevision: 1,
    expectedRun: null,
    catalogRevision: 'catalog-7',
    requestId: 'settings-7',
    mode: 'next',
    selection: {
      primary: null,
      parametersFor: 'codex',
      model: null,
      effort: ''
    },
  };
  const fx = await pipelineFixture(t, (_seen, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end('{"schema":1,"receipt":{"state":"saved"}}');
  });
  const result = await fx.run(['runner-set', '7'], input);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(fx.requests[0]!.body.toString()), input);

  const count = fx.requests.length;

  for (const bad of [{
      ...input, identity: {
        ...identity, task: '8'
      }
    }, {
      ...input, expectedRun: {
        id: 'run', epoch: 0
      }
    }, {
      ...input, mode: 'force'
    }]) {
    assert.equal((await fx.run(['runner-set', '7'], bad)).code, 2);
  }

  assert.equal(fx.requests.length, count);
});

test('PIPE-SETTINGS-READ: каталог адресует точный stage/provider без POST', async (t) => {
  const fx = await pipelineFixture(t, (_seen, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end('{"schema":1}');
  });
  const attempt = 'a_' + 'a'.repeat(32);
  const result = await fx.run(['runner-options', '7', 'demo', attempt, 'plan', 'PLAN', 'codex']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.requests[0]?.method, 'GET');
  assert.equal(fx.requests[0]?.url, '/api/tasks/7/runner/options?' + new URLSearchParams({
    profile: 'demo',
    attempt,
    node: 'plan',
    stage: 'PLAN',
    provider: 'codex',
  }));
});
test('PIPE-BOOTSTRAP: собственный exact stop и полный ответ сохраняются', async (t) => {
  const fx = await pipelineFixture(t, (_seen, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end('{"ok":true,"outcome":"recorded"}');
  });
  const input = {
    profile: 'demo',
    attempt: 'a_' + 'a'.repeat(32),
    phase: 'bootstrap',
    node: 'scout',
    visitId: 'b_' + 'b'.repeat(32),
    stopHash: 'c'.repeat(64),
    answer: 'Ответ\nПолный текст',
  };
  const result = await fx.run(['bootstrap-answer', '7'], input);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(fx.requests[0]!.body.toString()), input);
  assert.equal(fx.requests.length, 1);
  assert.equal((await fx.run(['bootstrap-answer', '7'], {
    ...input, stopHash: 'wrong'
  })).code, 2);
  assert.equal(fx.requests.length, 1);
});

test('PIPE-BOOTSTRAP-UNICODE: TAB и codepoints проходят, NUL и превышение не отправляются', async (t) => {
  const fx = await pipelineFixture(t, (_seen, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end('{"ok":true}');
  });
  const body = {
    profile: 'demo',
    attempt: 'a_' + 'a'.repeat(32),
    phase: 'bootstrap',
    node: 'scout',
    visitId: 'b_' + 'b'.repeat(32),
    stopHash: 'c'.repeat(64),
    answer: '\t' + '🚀'.repeat(19000),
  };

  assert.equal((await fx.run(['bootstrap-answer', '7'], body)).code, 0);
  assert.equal(JSON.parse(fx.requests[0]!.body.toString()).answer, body.answer);

  for (const answer of ['🚀'.repeat(20001), 'Ответ\u0000']) {
    assert.equal((await fx.run(['bootstrap-answer', '7'], { ...body, answer })).code, 2);
  }

  assert.equal(fx.requests.length, 1);
});

test('PIPE-ARBITER: read/discuss/diagnose/apply/resume адресуют один conversation', async (t) => {
  const conversation = 'c_' + 'c'.repeat(32);
  const expectedStop = {
    task: '7',
    profile: 'demo',
    attempt: 'a_' + 'a'.repeat(32),
    node: 'verify',
    stop: 'human',
    stageSequence: 8,
    stageHeadHash: 'b'.repeat(64),
  };
  const requestId = '12345678-1234-4234-8234-123456789abc';
  const fx = await pipelineFixture(t, (_seen, response) => {
    response.statusCode = 202;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      conversationId: conversation,
      operationId: 'operation-1',
      outcome: 'queued'
    }));
  });
  const base = '/api/tasks/7/arbiter-conversations';
  const cases = [
    [['arbiter-start', '7'], {
        requestId, expectedStop
      }, base],
    [['arbiter-message', '7', conversation], {
      requestId,
      expectedStop,
      decisionRevision: 2,
      questionId: 'q1',
      customAnswer: 'Две\nстроки',
    }, base + '/' + conversation + '/messages'],
    [['arbiter-diagnose', '7', conversation], {
      requestId,
      expectedStop,
      decisionRevision: 2,
      proposalId: 'diagnose-1',
    }, base + '/' + conversation + '/diagnose'],
    [['arbiter-apply', '7', conversation], {
      requestId,
      expectedStop,
      decisionRevision: 2,
      proposalId: 'apply-1',
    }, base + '/' + conversation + '/apply'],
    [['arbiter-resume', '7', conversation], {
      requestId,
      applyOperationId: 'apply-1',
      acceptedEvent: {
          sequence: 9, headEventHash: 'd'.repeat(64)
        },
      expectedCurrentStage: {
          sequence: 9, headEventHash: 'd'.repeat(64)
        },
    }, base + '/' + conversation + '/resume'],
    [['arbiter-stop', '7'], {
        operationId: 'operation-1'
      }, base + '/stop'],
  ] as const;

  for (const [argv, input, path] of cases) {
    const result = await fx.run(argv, input);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).outcome, 'queued');
    assert.equal(fx.requests.at(-1)?.url, path);
    assert.deepEqual(JSON.parse(fx.requests.at(-1)!.body.toString()), input);
  }

  const before = fx.requests.length;

  assert.equal((await fx.run(['arbiter-start', '7'], {
    requestId, expectedStop: {
      ...expectedStop, task: '8'
    },
  })).code, 2);
  assert.equal(fx.requests.length, before);
});

test('PIPE-ARBITER-READ: current, страницы и текст журнала сохраняют свой формат', async (t) => {
  const conversation = 'c_' + 'c'.repeat(32);
  const base = '/api/tasks/7/arbiter-conversations';
  const fx = await pipelineFixture(t, (seen, response) => {
    if (seen.url.endsWith('/journal')) {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('Первая строка\nВторая строка\n');

      return;
    }

    response.setHeader('Content-Type', 'application/json');
    response.end('{"messages":[],"hasMore":true,"revision":5}');
  });
  const cases = [
    [['arbiter-current', '7'], base + '/current'],
    [['arbiter-show', '7', conversation], base + '/' + conversation + '?afterSequence=0&knownRevision=0'],
    [['arbiter-show', '7', conversation, '100', '5'],
      base + '/' + conversation + '?afterSequence=100&knownRevision=5'],
    [['arbiter-journal', '7', conversation], base + '/' + conversation + '/journal'],
  ] as const;

  for (const [argv, path] of cases) {
    const result = await fx.run(argv);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(fx.requests.at(-1)?.method, 'GET');
    assert.equal(fx.requests.at(-1)?.url, path);

    if (argv[0] === 'arbiter-journal') {
      assert.equal(result.stdout, 'Первая строка\nВторая строка\n');
    }
    else {
      assert.equal(JSON.parse(result.stdout).hasMore, true);
    }
  }
});

const failedMobile = {
  profile: 'demo',
  attempt: 'a_' + 'a'.repeat(32),
  node: 'gate_plan',
  state: 'paused',
  stop: null,
  sequence: 8,
  headEventHash: 'b'.repeat(64),
  orchPid: 0,
  terminal: null,
};

test('PIPE-PARTIAL: решение записано, продолжение не состоялось', async (t) => {
  const expected = {
    ok: true,
    resumed: false,
    resumeError: 'Стенд недоступен'
  };
  const fx = await pipelineFixture(t, (_seen, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(expected));
  });
  const result = await fx.run(['gate', '7', 'GATE_PLAN', 'approve'], {
    expectedMobile: failedMobile
  });

  assert.equal(result.code, 3);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.match(result.stderr, /сохран|продолж/i);
  assert.equal(fx.requests.length, 1);
});
test('PIPE-FAILURES: JSON, HTTP-причина и обрыв не дают ложный успех или повтор', async (t) => {
  for (const scenario of ['json', '403', 'disconnect']) {
    const fx = await pipelineFixture(t, (_seen, response) => {
      if (scenario === 'disconnect') {
        response.writeHead(200, {
          'Content-Type': 'application/json'
        });
        response.write('{"ok":');
        setImmediate(() => response.destroy());

        return;
      }

      response.statusCode = scenario === '403' ? 403 : 200;
      response.setHeader('Content-Type', 'application/json');
      response.end(scenario === '403'
        ? JSON.stringify({
          message: 'Отказ fixture-token\u0007 закрыт'
        }) : '{broken');
    });
    const result = await fx.run(['resume', '7'], {
      expectedMobile: failedMobile
    });

    assert.equal(result.code, 22);
    assert.equal(result.stdout, '');
    assert.equal(fx.requests.length, 1);
    assert.ok(!result.stderr.includes('fixture-token'));
    assert.ok(!result.stderr.includes('\u0007'));
    assert.match(result.stderr, /провер/i);
  }
});

test('PIPE-PARTIAL-OTHER: сохранённый runner и arbiter resume_failure возвращают 3', async (t) => {
  const attempt = 'a_' + 'a'.repeat(32);
  const cases = [
    {
      argv: ['runner-set', '7'],
      input: {
        identity: {
          task: '7',
          profile: 'demo',
          attempt,
          node: 'plan',
          stage: 'PLAN'
        },
        expectedRevision: 1,
        expectedRun: null,
        catalogRevision: 'catalog',
        requestId: 'settings',
        mode: 'next',
        selection: {
          primary: null,
          parametersFor: 'codex',
          model: null,
          effort: ''
        },
      },
      output: { receipt: { state: 'failed', reason: 'restart failed' } },
    },
    {
      argv: ['arbiter-resume', '7', 'c_' + 'c'.repeat(32)],
      input: {
        requestId: '12345678-1234-4234-8234-123456789abc',
        applyOperationId: 'apply-1',
        acceptedEvent: { sequence: 9, headEventHash: 'd'.repeat(64) },
        expectedCurrentStage: { sequence: 9, headEventHash: 'd'.repeat(64) },
      },
      output: { outcome: 'resume_failed' },
    },
  ];

  for (const item of cases) {
    const fx = await pipelineFixture(t, (_seen, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(item.output));
    });
    const result = await fx.run(item.argv, item.input);

    assert.equal(result.code, 3);
    assert.deepEqual(JSON.parse(result.stdout), item.output);
    assert.equal(fx.requests.length, 1);
  }
});

const source = 'fixture-a@' + 'a'.repeat(64);

test('PIPE-LAUNCH: явный источник и снимок доходят в один POST', async (t) => {
  const options = {

    profile: 'demo',
    catalogHash: 'b'.repeat(64),
    routes: ['feature']

  };
  const fx = await pipelineFixture(t, (seen, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(seen.method === 'GET' ? options : {
      ok: true, attempt: 'a_' + 'c'.repeat(32)
    }));
  });
  const read = await fx.run(['launch-options', '7', 'demo', source]);

  assert.equal(read.code, 0, read.stderr);

  const snapshot = JSON.parse(read.stdout);

  assert.deepEqual(snapshot.options, options);
  assert.equal(snapshot.expectedLaunch, '4a924204c6fb83e9ef0e0ae641c2a3d1c18ed4ae1e0995a0ec3ac7d571d4b915');

  const input = {
    profile: 'demo',
    route: 'feature',
    source,
    expectedCatalogHash: options.catalogHash,
    expectedLaunch: snapshot.expectedLaunch,
    description: 'Две строки\nВторая строка с emoji 🧩',
  };
  const started = await fx.run(['launch', '7'], input);

  assert.equal(started.code, 0, started.stderr);

  assert.equal(fx.requests.filter((row) => row.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(fx.requests.at(-1)!.body.toString()), input);
  assert.equal(fx.requests[0]!.url, '/api/tasks/7/launch-options?' + new URLSearchParams({
    profile: 'demo', source
  }));
});
test('PIPE-INPUT: повреждённый, слишком большой и неточный запуск не делает POST', async (t) => {
  const fx = await pipelineFixture(t, (_seen, response) => {
    response.end('{}');
  });
  const valid = {

    profile: 'demo',
    route: 'feature',
    source,

    expectedCatalogHash: 'b'.repeat(64),
    expectedLaunch: 'c'.repeat(64),

  };

  for (const input of ['{broken', 'null', '[]', '{"a":"' + 'x'.repeat(262144) + '"}', {
      ...valid, source: 'fixture-a'
    }, {
      ...valid, route: ''
    }, {
      ...valid, expectedLaunch: ''
    }, {
      ...valid, shell: 'echo forbidden'
    }]) {
    const result = await fx.run(['launch', '7'], input);

    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
  }

  assert.equal(fx.requests.length, 0);
});

test('PIPE-GO-GET: закрытый набор читающих команд сохраняет путь, данные и basis', async (t) => {
  const fixture = await pipelineFixture(t, (_request, response) => {
    response.end(JSON.stringify({
      title: 'Проверка',
      text: 'Проверка\n',
      model: '["x","модель"]',
    }));
  });
  const cases = [
    [['list'], '/api/tasks?sources=1'],
    [['status', '7'], '/api/tasks/7'],
    [['state', '7'], '/api/tasks/7/mobile-state'],
    [['graph', '7'], '/api/tasks/7/graph'],
    [['doc', '7', 'plan'], '/api/tasks/7/doc/plan'],
    [['profiles'], '/api/profiles'],
    [['runners'], '/api/factory/runners'],
    [['slots', 'demo'], '/api/factory/slots?profile=demo'],
    [['source', 'fixture-a'], '/api/tracker/fixture-a/context'],
  ] as const;

  for (const [args, path] of cases) {
    const result = await fixture.run(args);
    const received = fixture.requests.at(-1);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(payload.title, 'Проверка');
    assert.equal(payload.model, '["x","модель"]');
    assert.equal(received?.url, path);
    assert.equal(received?.method, 'GET');
    assert.equal(received?.headers['x-grigdesk-token'], token);

    if (args[0] === 'doc') {
      assert.deepEqual(payload.basis, {
        name: 'plan',
        hash: 'd8c7523645ed48289d47e81e3e71b5e8cbaf9709a5dca247b7eecffdf779f120',
      });
    }
  }

  assert.equal(fixture.requests.length, cases.length);
});
