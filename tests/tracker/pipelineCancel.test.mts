import assert from 'node:assert/strict';
import test from 'node:test';
import { B24Error } from '../../tracker/src/errors.ts';
import { pipelineFixture } from './helpers/pipelineFixture.mts';

test('PIPE-CANCEL: зависший ответ закрывается без повторного POST', {
    timeout: 5000
}, async (t) => {
    let started!: () => void;
    let finishResponse!: () => void;
    const received = new Promise<void>((resolve) => {
        started = resolve;
    });
    const fx = await pipelineFixture(t, (_seen, response) => {
        response.writeHead(200, {
            'Content-Type': 'application/json'
        });
        response.write('{"accepted":');
        finishResponse = () => response.end('true}');
        started();
    });
    const controller = new AbortController();
    const running = fx.run(['status', '7'], undefined, {
        signal: controller.signal
    });

    await received;
    controller.abort(new B24Error(130, 'Команда pipeline отменена.'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    finishResponse();

    const result = await running;

    assert.equal(result.code, 130);
    assert.equal(result.stdout, '');
    assert.equal(fx.requests.length, 1);
});
