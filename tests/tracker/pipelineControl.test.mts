import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineFixture } from './helpers/pipelineFixture.mts';

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
