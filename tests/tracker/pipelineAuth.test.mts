import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthStore } from '../../server/src/lib/authStore.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { pipelineFixture } from './helpers/pipelineFixture.mts';

const Fastify = createRequire(new URL('../../server/package.json', import.meta.url))('fastify');

test('PIPE-AUTH: CLI-токен допускает мутацию, чужой токен не допускает эффекта', async (t) => {
    const app = Fastify({
        logger: false
    });
    let effects = 0;
    const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'pipeline-auth-'));
    const authStore = new AuthStore({
        legacyAccountPath: path.join(storeRoot, 'account.json'),
        sessionsPath: path.join(storeRoot, 'sessions.json'),
    });

    t.after(async () => {
        await app.close();
        await rm(storeRoot, {
            recursive: true, force: true
        });
    });
    await app.register(authPlugin, {
        authStore,
        cliToken: 'fixture-token',
    });
    app.post('/api/tasks/7/resume', async () => {
        effects += 1;

        return {
            ok: true
        };
    });
    await app.ready();

    const fx = await pipelineFixture(t, async (seen, response) => {
        const result = await app.inject({
            method: seen.method,
            url: seen.url,
            headers: seen.headers,
            payload: seen.body,
        });

        response.statusCode = result.statusCode;
        response.setHeader('Content-Type', 'application/json');
        response.end(result.rawPayload);
    });
    const input = {
        expectedMobile: {
            profile: 'demo',
            attempt: 'a_' + 'a'.repeat(32),
            node: 'build',
            state: 'ready',
            stop: null,
            sequence: 8,
            headEventHash: 'b'.repeat(64),
            orchPid: 0,
            terminal: null,
        },
    };

    assert.equal((await fx.run(['resume', '7'], input)).code, 0);
    assert.equal(effects, 1);

    const denied = await fx.run(['resume', '7'], input, {
        env: {
            GRIGDESK_URL: fx.baseUrl, GRIGDESK_TOKEN: 'wrong-token'
        },
    });

    assert.equal(denied.code, 22);
    assert.equal(denied.stdout, '');
    assert.equal(effects, 1);
});
