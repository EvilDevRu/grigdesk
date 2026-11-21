import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineFixture } from './helpers/pipelineFixture.mts';

test('PIPE-CANCEL: зависший ответ закрывается без повторного POST', {
    timeout: 5000
}, async (t) => {
    let started!: () => void;
    const received = new Promise<void>((resolve) => {
        started = resolve;
    });
    const fx = await pipelineFixture(t, (_seen, response) => {
        response.writeHead(200, {
            'Content-Type': 'application/json'
        });
        response.write('{"accepted":');
        started();
    });
    const controller = new AbortController();
    const running = fx.run(['resume', '7'], { expectedMobile: {
        profile: 'demo',
        attempt: 'a_' + 'a'.repeat(32),
        node: 'build',
        state: 'ready',
        stop: null,
        sequence: 8,
        headEventHash: 'b'.repeat(64),
        orchPid: 0,
        terminal: null,
    } }, {
        signal: controller.signal
    });

    await received;
    controller.abort();

    const result = await running;

    assert.equal(result.code, 130);
    assert.equal(result.stdout, '');
    assert.deepEqual(fx.requests.map((request) => request.method), ['POST']);
});
