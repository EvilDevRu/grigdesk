import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineFixture } from './helpers/pipelineFixture.mts';

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
