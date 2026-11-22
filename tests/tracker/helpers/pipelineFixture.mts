import type { TestContext } from 'node:test';

import { fixtureGo } from '../../helpers/goBuildFixture.mts';
import { startHttpFixture } from './httpFixture.mts';
import type { FixtureHandler } from './httpFixture.mts';
import { runProcess, syntheticHome } from './processFixture.mts';

/**
 * Запускает собранный pipeline с временным HOME и loopback API.
 * Передаёт stdin и сигналы через настоящий дочерний процесс.
 */
export async function pipelineFixture(t: TestContext, handler: FixtureHandler) {
    const server = await startHttpFixture(t, handler);
    const { home, data } = await syntheticHome();

    return {
        ...server,
        async run(argv: readonly string[], input?: unknown, options: {
            env?: Record<string, string>;
            signal?: AbortSignal;
        } = {}) {
            const result = await runProcess(t, fixtureGo('pipeline'), argv, {
                env: {
                    PATH: '',
                    HOME: home,
                    GRIGDESK_HOME: data,
                    GRIGDESK_URL: server.baseUrl,
                    GRIGDESK_TOKEN: 'fixture-token',
                    ...options.env,
                },
                input: typeof input === 'string' ? input : JSON.stringify(input),
                interrupt: options.signal,
            });

            return {
                code: result.code,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString(),
            };
        },
    };
}
