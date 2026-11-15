import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildBinary } from '../../../tracker/scripts/build.mts';
import { runProcess } from '../helpers/processFixture.mts';
import { startHttpFixture } from '../helpers/httpFixture.mts';

const packageDir = fileURLToPath(new URL('../../../tracker/', import.meta.url));

test('SEA-PIPELINE: builder выпускает независимый pipeline, а не tracker', {
    timeout: 900000
}, async (t) => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'pipeline-sea-'));

    t.after(() => rm(work, { recursive: true, force: true }));

    const outDir = path.join(work, 'out');
    const cacheDir = path.join(work, 'cache');

    await mkdir(cacheDir, {
        recursive: true
    });

    const archive = 'node-v24.21.0-linux-x64.tar.xz';

    await copyFile(path.join(packageDir, '.cache', archive), path.join(cacheDir, archive))
        .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    });
    await Reflect.apply(buildBinary, undefined, [{
            outDir, cacheDir
        }, 'pipeline']);

    const built = path.join(outDir, 'pipeline');

    assert.equal(existsSync(built), true, 'общий builder должен выпускать выбранный pipeline');
    assert.equal((await stat(built)).mode & 0o777, 0o755);

    const binary = path.join(work, 'pipeline');
    const head = Buffer.alloc(4);

    await copyFile(built, binary);

    const handle = await open(binary, 'r');

    try {
        await handle.read(head, 0, 4, 0);
    }
    finally {
        await handle.close();
    }

    assert.deepEqual([...head], [0x7f, 0x45, 0x4c, 0x46]);

    const env = {
        PATH: '',
        HOME: work,
        GRIGDESK_HOME: 'relative-invalid',
        NODE_OPTIONS: '--require=/does-not-exist/no-side-effect.js',
    };

    for (const flag of ['--help', '--version', '--license']) {
        const result = await runProcess(t, binary, [flag], {
            env
        });

        assert.equal(result.code, 0, result.stderr.toString());
        assert.equal(result.stderr.length, 0);
        assert.ok(result.stdout.length > 0);
    }

    const server = await startHttpFixture(t, (_seen, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end('{"task":"7","result":"completed"}');
    });
    const result = await runProcess(t, binary, ['status', '7'], {
        env: {
            ...env,
            GRIGDESK_URL: server.baseUrl,
            GRIGDESK_TOKEN: 'fixture-token'
        },
    });

    assert.equal(result.code, 0, result.stderr.toString());
    assert.equal(JSON.parse(result.stdout.toString()).task, '7');
    assert.equal(server.requests[0]?.url, '/api/tasks/7');
});
