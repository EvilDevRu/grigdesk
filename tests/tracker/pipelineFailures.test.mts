import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineFixture } from './helpers/pipelineFixture.mts';

const mobile = {
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
        expectedMobile: mobile
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
            expectedMobile: mobile
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
