import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineFixture } from './helpers/pipelineFixture.mts';

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
    assert.match(snapshot.expectedLaunch, /^[a-f0-9]{64}$/u);

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
