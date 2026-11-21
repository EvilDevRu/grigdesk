import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { writeInstallationJson } from '../../shared/node/installedLayout.ts';
import { installedFixture } from '../helpers/installedUpdateFixture.mjs';
import { completed } from './helpers/sandbox.mts';
import { goCandidate } from '../helpers/goCandidate.mts';
import { signedIndex } from '../helpers/releaseV2Fixture.mjs';
import { canonicalJson } from '../../shared/lib/canonicalJson.ts';

const go = process.env.GRIGDESK_INSTALLED_TEST_GO === '1';
const fixtureSeed = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.alloc(32, 0x43),
]);
const privateKey = createPrivateKey({
    key: fixtureSeed,
    type: 'pkcs8',
    format: 'der',
});
const keys = { privateKey, publicKey: createPublicKey(privateKey) };
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * Настоящий installed entry получает приватные receipt/current готовой фикстуры.
 * Только executable заменён наблюдателем: сеть, сервер и пользовательская установка не нужны.
 */
async function installedPipelineFixture(t: TestContext, mode: 'local' | 'server' | 'remote' = 'server') {
    const box = await installedFixture(t, { mode });
    const calls = path.join(box.temporary, 'pipeline-calls.log');
    const entry = path.join(box.temporary, 'pipeline-entry.mjs');
    const cliUrl = new URL('../../tests/fixtures/legacy-ctl/cli/installedCli.ts', import.meta.url).href;
    const fallback = path.join(box.temporary, 'foreign-bin');
    const executable = path.join(box.root, 'bin/grigdesk-ctl');

    await fs.mkdir(fallback, { mode: 0o700 });

    if (go) {
        await fs.mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
        await fs.copyFile(goCandidate('grigdesk-ctl'), executable);
        await fs.chmod(executable, 0o755);
    }

    await fs.writeFile(entry, [
        `const { runInstalledCli } = await import(${JSON.stringify(cliUrl)});`,
        `process.exitCode = await runInstalledCli(${JSON.stringify(box.root)}, process.argv.slice(2));`,
    ].join('\n'));

    /**
     * Абсолютный shebang использует Node теста без поиска по PATH.
     * Наблюдатель пишет один вызов и сохраняет байты stdin, argv и выбранные папки среды.
     */
    async function probe(file: string, generation: string) {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(file, [
            `#!${process.execPath}`,
            'const fs = require("node:fs");',
            `const generation = ${JSON.stringify(generation)};`,
            `fs.appendFileSync(${JSON.stringify(calls)}, generation + "\\n");`,
            'const chunks = [];',
            'process.stdin.on("data", (chunk) => chunks.push(chunk));',
            'process.stdin.on("end", () => {',
            '  const keys = ["GRIGDESK_HOME", "GRIGDESK_ENV_FILE", "GRIGDESK_DESKTOP_DATA_DIR",',
            '    "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "APPIMAGE", "APPDIR"];',
            '  const env = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));',
            '  const input = Buffer.concat(chunks).toString("utf8");',
            '  const record = { generation, argv: process.argv.slice(2), input, env };',
            '  process.stdout.write(JSON.stringify(record) + "\\n");',
            '  process.stderr.write("selected:" + generation + "\\n");',
            `  process.exitCode = ${go ? 17 : 22};`,
            '});',
        ].join('\n') + '\n', { mode: 0o755 });
    }

    const first = path.join(box.root, 'generations/0.2.0/server/bin/pipeline');
    const second = path.join(box.root, 'generations/0.3.0/server/bin/pipeline');

    await probe(first, '0.2.0');
    await probe(second, '0.3.0');
    await probe(path.join(fallback, 'pipeline'), 'PATH-fallback');

    if (go) {
        for (const name of ['tracker', 'routes', 'voice']) {
            await probe(path.join(path.dirname(first), name), name);
            await probe(path.join(fallback, name), 'PATH-fallback');
        }

        await pinGeneration(box.root, first, '0.2.0');
        await pinGeneration(box.root, second, '0.3.0');
    }

    /**
     * Процесс запускается точным Node с pipe-stdin, общий completed удерживает deadline.
     * Чужие папки среды нужны только как данные для проверки замены путями receipt.
     */
    async function run(argv: string[], input = '') {
        const child = spawn(go ? executable : process.execPath, go ? argv : [entry, ...argv], {
            cwd: box.temporary,
            env: {
                ...process.env,
                HOME: box.temporary,
                PATH: fallback,
                GRIGDESK_HOME: path.join(box.temporary, 'wrong-data'),
                GRIGDESK_ENV_FILE: path.join(box.temporary, 'wrong.env'),
                GRIGDESK_DESKTOP_DATA_DIR: path.join(box.temporary, 'wrong-user'),
                NODE_OPTIONS: '--no-warnings',
                ELECTRON_RUN_AS_NODE: '1',
                APPIMAGE: '/fixture/wrong-appimage',
                APPDIR: '/fixture/wrong-appdir',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const done = completed(child);

        child.stdin!.end(input);

        return done;
    }

    return {
        box,
        calls,
        first,
        second,
        run
    };
}

/**
 * Инвентарь использует фиксированный независимый Ed25519 ключ теста.
 * Инъекция ключа доступна только в сборке кандидата этого сценария.
 */
async function pinGeneration(root: string, executable: string, version: string) {
    const bytes = await fs.readFile(executable);
    const fixture = signedIndex({ keys, version });
    const artifact = fixture.envelope.payload.artifacts.server;

    artifact.files = [{
        path: 'bin/pipeline',
        size: bytes.length,
        sha256: hash(bytes),
        mode: 0o755,
    }];
    artifact.filesDigest = hash(canonicalJson(artifact.files));
    artifact.unpackedSize = bytes.length;

    const policy = Buffer.from(`GrigDesk release v2\n${canonicalJson(fixture.envelope.payload)}\n`);

    fixture.envelope.signature = sign(null, policy, privateKey).toString('base64');
    await fs.chmod(executable, 0o555);
    await writeInstallationJson(root, `generations/${version}/release.json`, fixture.envelope);
}

test('PIPE-INSTALLED-ENTRY: current, argv/stdin/exit и отсутствие fallback', async (t) => {
    const fx = await installedPipelineFixture(t);
    const input = '{"comment":"Ответ человека\\nцеликом"}\n';
    const argv = ['pipeline', 'gate', '7', 'approve', 'точный аргумент с пробелами'];
    const first = await fx.run(argv, input);

    assert.equal(first.code, go ? 17 : 22, first.stderr);
    assert.equal(first.stderr, 'selected:0.2.0\n');
    assert.deepEqual(JSON.parse(first.stdout), {
        generation: '0.2.0',
        argv: argv.slice(1),
        input,
        env: {
            GRIGDESK_HOME: fx.box.receipt.dataHome,
            GRIGDESK_ENV_FILE: path.join(fx.box.receipt.dataHome, '.env'),
            GRIGDESK_DESKTOP_DATA_DIR: fx.box.receipt.userData,
            NODE_OPTIONS: null,
            ELECTRON_RUN_AS_NODE: null,
            APPIMAGE: null,
            APPDIR: null,
        },
    });

    await writeInstallationJson(fx.box.root, 'current.json', {
        ...fx.box.previous,
        server: 'generations/0.3.0/server',
    });

    const second = await fx.run(['pipeline', '--help']);

    assert.equal(second.code, go ? 17 : 22, second.stderr);
    assert.equal(second.stderr, 'selected:0.3.0\n');
    assert.deepEqual(JSON.parse(second.stdout).argv, ['--help']);
    assert.equal(JSON.parse(second.stdout).generation, '0.3.0');
    assert.equal(await fs.readFile(fx.calls, 'utf8'), '0.2.0\n0.3.0\n');

    if (go) {
        const bytes = await fs.readFile(fx.second);

        await fs.chmod(fx.second, 0o755);
        await fs.writeFile(fx.second, Buffer.concat([bytes, Buffer.from('\n// changed\n')]));
        await fs.chmod(fx.second, 0o555);

        const corrupt = await fx.run(['pipeline', 'list']);

        assert.equal(corrupt.code, 1, corrupt.stderr);
        assert.equal(await fs.readFile(fx.calls, 'utf8'), '0.2.0\n0.3.0\n');
    }

    await fs.rm(fx.second);

    const missing = await fx.run(['pipeline', 'list']);

    assert.equal(missing.code, 1, missing.stderr);
    assert.equal(missing.stdout, '');
    assert.notEqual(missing.stderr, '');
    assert.equal(await fs.readFile(fx.calls, 'utf8'), '0.2.0\n0.3.0\n');

    await fs.symlink(fx.first, fx.second);

    const unsafe = await fx.run(['pipeline', 'list']);

    assert.equal(unsafe.code, 1, unsafe.stderr);
    assert.equal(unsafe.stdout, '');
    assert.equal(await fs.readFile(fx.calls, 'utf8'), '0.2.0\n0.3.0\n');
    await fx.box.preserved();
});

test('PIPE-INSTALLED-REMOTE: отсутствие server не выбирает найденный ELF или PATH', async (t) => {
    const fx = await installedPipelineFixture(t, 'remote');
    const result = await fx.run(['pipeline', 'list']);

    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.notEqual(result.stderr, '');
    await assert.rejects(fs.access(fx.calls), { code: 'ENOENT' });
    await fx.box.preserved();
});

for (const mode of ['local', 'server', 'remote'] as const) {
    test(`PIPE-INSTALLED-MATRIX: прямые agent CLI и запрет argv у ctl в режиме ${mode}`, {
        skip: !go,
    }, async (t) => {
        const fx = await installedPipelineFixture(t, mode);

        for (const name of ['tracker', 'routes', 'voice']) {
            const result = await fx.run([name, 'list']);

            assert.equal(result.code, 2, result.stderr);
            await assert.rejects(fs.access(fx.calls), { code: 'ENOENT' });

            if (mode !== 'remote') {
                const child = spawn(path.join(path.dirname(fx.first), name), ['exact'], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                const direct = await completed(child);

                assert.equal(direct.code, 17, direct.stderr);
                assert.equal(direct.stderr, `selected:${name}\n`);
                assert.deepEqual(JSON.parse(direct.stdout).argv, ['exact']);
                await fs.rm(fx.calls);
            }
        }
    });
}

test('PIPE-INSTALLED-MAINTENANCE: мутация передаётся только закреплённому helper', {
    skip: !go,
}, async (t) => {
    const fx = await installedPipelineFixture(t);
    const helper = path.join(fx.box.root, 'update/maintenance');
    const bytes = Buffer.from('#!/bin/sh\nprintf "<%s>\\n" "$@"\nexit 17\n');
    const control = 'generations/0.2.0';

    await fs.writeFile(helper, bytes, { mode: 0o700 });
    await writeInstallationJson(fx.box.root, 'update/maintenance.json', {
        schema: 1,
        installationId: fx.box.receipt.installationId,
        size: bytes.length,
        sha256: hash(bytes),
    });

    const legacy = await fx.run(['server', 'update', '--json']);

    assert.equal(legacy.code, 1, legacy.stderr);
    assert.match(legacy.stderr, /завершите переход на Go/u);

    await fs.mkdir(path.join(fx.box.root, control, 'bin'), { mode: 0o700 });
    await writeInstallationJson(fx.box.root, 'current.json', {
        ...fx.box.previous,
        format: 2,
        control,
        floor: '0.2.0',
    });

    const accepted = await fx.run(['server', 'update', '--json']);

    assert.equal(accepted.code, 17, accepted.stderr);
    assert.equal(accepted.stdout, '<ctl-runtime>\n<server>\n<update>\n<--json>\n');
    await fs.appendFile(helper, '# changed\n');

    const refused = await fx.run(['server', 'update', '--json']);

    assert.equal(refused.code, 1, refused.stderr);
    assert.equal(refused.stdout, '');
});
