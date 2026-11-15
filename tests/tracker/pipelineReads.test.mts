import assert from 'node:assert/strict';
import test from 'node:test';
import { runPipeline } from '../../tracker/src/pipelineApp.ts';
import { request } from '../../tracker/src/http.ts';
import { startHttpFixture } from './helpers/httpFixture.mts';

test('PIPE-GET: закрытые команды читают API и сохраняют русские данные', async (t) => {
    const server = await startHttpFixture(t, (_request, response) => {
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
        let output = '';
        let stdin = 0;
        const code = await runPipeline(argv, {
            version: '0.1.0', license: () => ''
        }, {
            env: {
                GRIGDESK_URL: server.baseUrl, GRIGDESK_TOKEN: 'fixture-token'
            },
            getHome: () => {
                throw new Error('HOME не нужен');
            },
            readText: async () => {
                throw new Error('Файлы не нужны');
            },
            readStdin: async () => {
                stdin += 1;

                throw new Error('stdin не нужен');
            },
            request,
            writeStdout: async (value) => {
                output += Buffer.from(value).toString();
            },
            writeStderr: async (value) => {
                assert.fail(value);
            },
        });

        assert.equal(code, 0, argv.join(' '));
        assert.equal(JSON.parse(output).title, 'Проверка');
        assert.equal(stdin, 0);
        assert.equal(server.requests.at(-1)?.url, path);
        assert.equal(server.requests.at(-1)?.headers['x-grigdesk-token'], 'fixture-token');
        assert.equal(server.requests.at(-1)?.method, 'GET');
    }

    assert.equal(server.requests.filter((row) => row.method === 'POST').length, 0);
});
test('PIPE-GET-INPUT: плохой task и неизвестная команда не читают подключение', async () => {
    for (const argv of [['state', '7x'], ['state', '0007'], ['state', '90071992547409931x'],
        ['raw', '/api/settings'], ['gate', '7', 'GATE_PLAN', 'approve', '--yes']]) {
        let reads = 0;
        let output = '';
        const code = await runPipeline(argv, {
            version: '0.1.0', license: () => ''
        }, {
            env: {},
            getHome: () => {
                reads += 1;

                return '/missing';
            },
            readText: async () => {
                reads += 1;

                return null;
            },
            readStdin: async () => {
                reads += 1;

                return new Uint8Array();
            },
            request: async () => {
                reads += 1;

                return new Uint8Array();
            },
            writeStdout: async (value) => {
                output += Buffer.from(value).toString();
            },
            writeStderr: async () => undefined,
        });

        assert.equal(code, 2);
        assert.equal(reads, 0);
        assert.equal(output, '');
    }
});
