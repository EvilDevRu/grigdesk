import type { TestContext } from 'node:test';
import { runPipeline } from '../../../tracker/src/pipelineApp.ts';
import type { PipelineIO } from '../../../tracker/src/pipelineApp.ts';
import { request } from '../../../tracker/src/http.ts';
import { startHttpFixture } from './httpFixture.mts';
import type { FixtureHandler } from './httpFixture.mts';
/**
 * Проверяет новый CLI через настоящий HTTP-транспорт на временном loopback.
 * Вызовы модели, живой профиль и файлы авторизации владельца недоступны.
 */
export async function pipelineFixture(t: TestContext, handler: FixtureHandler) {
    const server = await startHttpFixture(t, handler);

    return {
        ...server,
        /**
         * Запускает команду с изолированным вводом и настоящим HTTP-клиентом.
         * Возвращает вывод и число чтений stdin для поведенческих проверок.
         */
        async run(argv: readonly string[], input?: unknown, overrides: Partial<PipelineIO> = {}) {
            let stdout = '';
            let stderr = '';
            let stdinReads = 0;
            const code = await runPipeline(argv, {
                version: '0.1.0', license: () => 'LICENSE\n'
            }, {
                env: {
                    GRIGDESK_URL: server.baseUrl, GRIGDESK_TOKEN: 'fixture-token'
                },
                getHome: () => {
                    throw new Error('HOME запрещён');
                },
                readText: async () => {
                    throw new Error('Файлы запрещены');
                },
                request,
                async readStdin() {
                    stdinReads += 1;

                    return Buffer.from(typeof input === 'string' ? input : JSON.stringify(input ?? {}));
                },
                writeStdout: async (value) => {
                    stdout += Buffer.from(value).toString();
                },
                writeStderr: async (value) => {
                    stderr += value;
                },
                ...overrides,
            });

            return {

                code,
                stdout,
                stderr,
                stdinReads

            };
        },
    };
}
