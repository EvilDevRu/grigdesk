import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineFixture } from './helpers/pipelineFixture.mts';

test('PIPE-GET: закрытые команды читают API и сохраняют русские данные', async (t) => {
    const server = await pipelineFixture(t, (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({

            title: 'Проверка',
            text: 'Проверка',
            model: '["x","модель"]'

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

    for (const [argv, path] of cases) {
        const result = await server.run(argv);

        assert.equal(result.code, 0, argv.join(' '));
        assert.equal(result.stderr, '');
        assert.equal(JSON.parse(result.stdout).title, 'Проверка');
        assert.equal(server.requests.at(-1)?.url, path);
        assert.equal(server.requests.at(-1)?.headers['x-grigdesk-token'], 'fixture-token');
        assert.equal(server.requests.at(-1)?.method, 'GET');
    }

    assert.equal(server.requests.filter((row) => row.method === 'POST').length, 0);
});
test('PIPE-GET-INPUT: плохой task и неизвестная команда не вызывают API', async (t) => {
    const server = await pipelineFixture(t, () => assert.fail('вызван API'));

    for (const argv of [['state', '7x'], ['state', '0007'], ['state', '90071992547409931x'],
        ['raw', '/api/settings'], ['gate', '7', 'GATE_PLAN', 'approve', '--yes']]) {
        const result = await server.run(argv, undefined, {
            env: { GRIGDESK_URL: 'неверный адрес', GRIGDESK_TOKEN: '' },
        });

        assert.equal(result.code, 2);
        assert.equal(result.stdout, '');
        assert.equal(server.requests.length, 0);
    }
});
