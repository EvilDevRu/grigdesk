import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineFixture } from './helpers/pipelineFixture.mts';

const attempt = 'a_' + 'a'.repeat(32);
const identity = {
    profile: 'demo',
    attempt,
    node: 'build',
    state: 'ready',
    stop: null,
    sequence: 8,
    headEventHash: 'b'.repeat(64),
    orchPid: 0,
    terminal: null,
};

test('PIPE-WAIT-HANDOFF: ready без PID не завершает ожидание', async (t) => {
    let time = 0;
    let sleeps = 0;
    const fx = await pipelineFixture(t, (seen, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(seen.url.endsWith('/mobile-state')
            ? {
                identity: {
                    ...identity, terminal: sleeps ? 'completed' : null
                }, running: false
            }
            : {
                attempt,
                profile: 'demo',
                daemonAlive: true,
                readOnly: false,
                registry: {}
            }));
    });
    const result = await fx.run(['wait', '7', attempt, '100', '10'], undefined, {
        now: () => time,
            armDeadline: () => ({ signal: new AbortController().signal, dispose: () => undefined }),
        sleep: async (ms) => {
            time += ms;
            sleeps += 1;
        },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).outcome, 'terminal');
    assert.equal(JSON.parse(result.stdout).identity.attempt, attempt);
    assert.equal(sleeps, 1);
});
test('PIPE-WAIT: timeout, human, manual stop и новый attempt различаются', async (t) => {
    for (const scenario of ['timeout', 'human', 'stopped', 'replaced']) {
        let time = 0;
        const fx = await pipelineFixture(t, (seen, response) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(seen.url.endsWith('/mobile-state') ? {
                identity: {
                    ...identity,
                    attempt: scenario === 'replaced' ? 'a_' + 'c'.repeat(32) : attempt,
                    state: scenario === 'human' ? 'paused' : 'ready',
                },
                running: false,
            } : {
                attempt,
                profile: 'demo',
                daemonAlive: false,
                readOnly: false,
                stall: null,
                registry: {
                    STOPPED_SIGNAL: scenario === 'stopped' ? '1' : '0'
                },
            }));
        });
        const result = await fx.run(['wait', '7', attempt, '20', '10'], undefined, {
            now: () => time,
            armDeadline: () => ({ signal: new AbortController().signal, dispose: () => undefined }),
            sleep: async (ms) => {
                time += ms;
            },
        });

        assert.equal(result.code, scenario === 'timeout' ? 124 : scenario === 'replaced' ? 22 : 0);

        if (scenario === 'replaced') {
            assert.equal(result.stdout, '');
        }
        else {
            assert.equal(JSON.parse(result.stdout).outcome, scenario);
        }
    }
});

test('PIPE-WAIT-PRELUDE: running без cursor ждёт cursor, human, timeout или замену attempt', async (t) => {
    for (const scenario of ['cursor', 'human', 'timeout', 'replaced']) {
        let time = 0;
        let sleeps = 0;
        const fx = await pipelineFixture(t, (seen, response) => {
            response.setHeader('Content-Type', 'application/json');

            const current = scenario === 'replaced' && sleeps ? 'a_' + 'c'.repeat(32) : attempt;
            const entered = scenario === 'cursor' && sleeps > 0;

            const bootstrapStop = scenario === 'human' && sleeps > 0 ? {
                state: 'waiting',
                visitId: 'b_' + 'b'.repeat(32),
                recordHash: 'd'.repeat(64),
            } : null;

            if (seen.url.endsWith('/prelude-state')) {
                response.end(JSON.stringify({
                    identity: {
                        profile: 'demo',
                        attempt: current,
                        orchPid: 0,
                        bootstrap: bootstrapStop ? {
                            visitId: bootstrapStop.visitId,
                            stopHash: bootstrapStop.recordHash,
                            state: 'waiting',
                            decisionHash: null,
                        } : null,
                    },
                    attempt: current,
                    profile: 'demo',
                    terminal: null,
                    running: !(scenario === 'human' && sleeps > 0),
                }));

                return;
            }

            response.end(JSON.stringify(seen.url.endsWith('/mobile-state') ? {
                identity: entered ? { ...identity, terminal: 'completed' } : null,
                running: !entered && !(scenario === 'human' && sleeps > 0),
            } : {
                attempt: current,
                profile: 'demo',
                daemonAlive: !(scenario === 'human' && sleeps > 0),
                readOnly: false,
                registry: {},
                bootstrapStop,
            }));
        });
        const result = await fx.run(['wait', '7', attempt, '20', '10'], undefined, {
            now: () => time,
            sleep: async (ms) => {
                time += ms;
                sleeps += 1;
            },
            armDeadline: () => ({ signal: new AbortController().signal, dispose: () => undefined }),
        });

        assert.equal(result.code, scenario === 'timeout' ? 124 : scenario === 'replaced' ? 22 : 0,
            result.stderr);
        assert.ok(sleeps > 0, 'молодая работающая attempt должна действительно ждать');

        if (scenario !== 'replaced') {
            assert.equal(JSON.parse(result.stdout).outcome, scenario === 'cursor' ? 'terminal' : scenario);
        }
    }
});

test('PIPE-WAIT-PRELUDE-TERMINAL: trusted terminal без cursor не заменяется registry result', async (t) => {
    for (const scenario of ['terminal', 'replaced', 'readOnly']) {
        const current = scenario === 'replaced' ? 'a_' + 'c'.repeat(32) : attempt;
        const fx = await pipelineFixture(t, (seen, response) => {
            response.setHeader('Content-Type', 'application/json');

            if (seen.url.endsWith('/mobile-state')) {
                response.end('{"identity":null,"running":false}');

                return;
            }

            if (seen.url.endsWith('/prelude-state')) {
                response.end(JSON.stringify({
                    identity: null,
                    running: false,
                    attempt: current,
                    profile: 'demo',
                    terminal: 'abandoned',
                }));

                return;
            }

            response.end(JSON.stringify({
                attempt: current,
                profile: 'demo',
                daemonAlive: false,
                readOnly: scenario === 'readOnly',
                result: 'completed',
                registry: { RESULT: 'completed' },
            }));
        });
        const result = await fx.run(['wait', '7', attempt], undefined, {
            sleep: async () => assert.fail('terminal или отказ не должны переходить к sleep'),
            armDeadline: () => ({ signal: new AbortController().signal, dispose: () => undefined }),
        });

        assert.equal(result.code, scenario === 'terminal' ? 0 : 22, result.stderr);

        if (scenario === 'terminal') {
            assert.equal(JSON.parse(result.stdout).outcome, 'terminal');
            assert.equal(JSON.parse(result.stdout).terminal, 'abandoned');
            assert.equal(JSON.parse(result.stdout).attempt, attempt);
            assert.equal(JSON.parse(result.stdout).identity, null);
        } else {
            assert.equal(result.stdout, '');
        }
    }
});

test('PIPE-WAIT-PHASE-RACE: null prelude при переходе к cursor '
    + 'не выдаёт старую human остановку', async (t) => {
    let sleeps = 0;
    let time = 0;
    const fx = await pipelineFixture(t, (seen, response) => {
        response.setHeader('Content-Type', 'application/json');

        if (seen.url.endsWith('/mobile-state')) {
            response.end(JSON.stringify({
                identity: sleeps ? { ...identity, terminal: 'completed' } : null,
                running: false,
            }));

            return;
        }

        if (seen.url.endsWith('/prelude-state')) {
            response.end(JSON.stringify({
                identity: null,
                running: false,
                attempt,
                profile: 'demo',
                terminal: null,
            }));

            return;
        }

        response.end(JSON.stringify({
            attempt,
            profile: 'demo',
            daemonAlive: false,
            readOnly: false,
            registry: {},
            stall: { kind: 'human', reason: 'Старый снимок стадии' },
        }));
    });
    const result = await fx.run(['wait', '7', attempt, '100', '10'], undefined, {
        now: () => time,
        sleep: async (ms) => {
                time += ms;
                sleeps += 1;
            },
        armDeadline: () => ({ signal: new AbortController().signal, dispose: () => undefined }),
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(sleeps, 1);
    assert.equal(JSON.parse(result.stdout).outcome, 'terminal');
});

test('PIPE-WAIT-DEADLINE: общий срок прерывает зависшее чтение HTTP', { timeout: 30000 }, async (t) => {
    let markReceived!: () => void;
    const received = new Promise<void>((resolve) => {
        markReceived = resolve;
    });
    const fx = await pipelineFixture(t, (_seen, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"identity":');
        markReceived();
    });
    const running = fx.run(['wait', '7', attempt, '5000', '10']);

    await received;

    const result = await running;

    assert.equal(result.code, 124, result.stderr);
    assert.equal(JSON.parse(result.stdout).outcome, 'timeout');
    assert.equal(fx.requests.length, 1);
});
