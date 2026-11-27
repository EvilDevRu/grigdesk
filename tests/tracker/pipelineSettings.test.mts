import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineFixture } from './helpers/pipelineFixture.mts';

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
    assert.equal(fx.requests[0]?.headers.accept, 'application/json; grigdesk-stage-speed=1');

    const speedInput = { ...input, selection: { ...input.selection, speed: 'fast' } };
    const speedResult = await fx.run(['runner-set', '7'], speedInput);

    assert.equal(speedResult.code, 0, speedResult.stderr);
    assert.deepEqual(JSON.parse(fx.requests.at(-1)!.body.toString()), speedInput);

    const calls = fx.requests.length;
    const invalidSpeed = { ...input, selection: { ...input.selection, speed: 'priority' } };
    const invalidResult = await fx.run(['runner-set', '7'], invalidSpeed);

    assert.equal(invalidResult.code, 2);
    assert.equal(fx.requests.length, calls);

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
    assert.equal(fx.requests[0]?.headers.accept, 'application/json; grigdesk-stage-speed=1');
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
