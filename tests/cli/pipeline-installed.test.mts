import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { writeInstallationJson } from '../../shared/node/installedLayout.ts';
import { installedFixture } from '../helpers/installedUpdateFixture.mjs';
import { completed } from './helpers/sandbox.mts';

/**
 * Настоящий installed entry получает приватные receipt/current готовой фикстуры.
 * Только executable заменён наблюдателем: сеть, сервер и пользовательская установка не нужны.
 */
async function installedPipelineFixture(t: TestContext, mode: 'server' | 'remote' = 'server') {
    const box = await installedFixture(t, { mode });
    const calls = path.join(box.temporary, 'pipeline-calls.log');
    const entry = path.join(box.temporary, 'pipeline-entry.mjs');
    const cliUrl = new URL('../../cli/installedCli.ts', import.meta.url).href;
    const fallback = path.join(box.temporary, 'foreign-bin');

    await fs.mkdir(fallback, { mode: 0o700 });
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
            '  process.exitCode = 22;',
            '});',
        ].join('\n') + '\n', { mode: 0o755 });
    }

    const first = path.join(box.root, 'generations/0.2.0/server/bin/pipeline');
    const second = path.join(box.root, 'generations/0.3.0/server/bin/pipeline');

    await probe(first, '0.2.0');
    await probe(second, '0.3.0');
    await probe(path.join(fallback, 'pipeline'), 'PATH-fallback');

    /**
     * Процесс запускается точным Node с pipe-stdin, общий completed удерживает deadline.
     * Чужие папки среды нужны только как данные для проверки замены путями receipt.
     */
    async function run(argv: string[], input = '') {
        const child = spawn(process.execPath, [entry, ...argv], {
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

test('PIPE-INSTALLED-ENTRY: current, argv/stdin/exit и отсутствие fallback', async (t) => {
    const fx = await installedPipelineFixture(t);
    const input = '{"comment":"Ответ человека\\nцеликом"}\n';
    const argv = ['pipeline', 'gate', '7', 'approve', 'точный аргумент с пробелами'];
    const first = await fx.run(argv, input);

    assert.equal(first.code, 22, first.stderr);
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

    assert.equal(second.code, 22, second.stderr);
    assert.equal(second.stderr, 'selected:0.3.0\n');
    assert.deepEqual(JSON.parse(second.stdout).argv, ['--help']);
    assert.equal(JSON.parse(second.stdout).generation, '0.3.0');
    assert.equal(await fs.readFile(fx.calls, 'utf8'), '0.2.0\n0.3.0\n');

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
