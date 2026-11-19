import { execFile } from 'node:child_process';
import { chmod, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { downloadFile, injectSea, nodeArchive, seaConfig } from './seaBuild.ts';
import { sha256File } from './hash.ts';
import { withWorkDirectory } from './files.ts';
import {
    assertUntracked, componentNodeRuntimeManifest, ensureNodeArchive, publishFile,
    readTargetNodeRuntime, seaHostTarget, SEA_FUSE,
} from './nodeRuntime.ts';
import type { CliBuildOptions } from './cliBuildArgs.ts';

interface BundleInput {
    entryPoints: string[];
    outfile: string;
    bundle: true;
    platform: 'node';
    format: 'cjs';
    target: 'node24';
    logLevel: 'silent';
}

export interface CliSeaBuild {
    packageDir: string;
    program: string;
    entry: string;
    options: CliBuildOptions;
    bundle(input: BundleInput): Promise<{ warnings: readonly { text: string }[] }>;
}

const run = promisify(execFile);

/**
 * Находит CLI postject по package.json внутри зависимостей выбранного пакета.
 * Поле bin бывает строкой или объектом с именем команды.
 */
async function postjectCli(packageDir: string): Promise<string> {
    const postject = path.join(packageDir, 'node_modules/postject');
    const manifest = JSON.parse(await readFile(path.join(postject, 'package.json'), 'utf8'));
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.postject;

    return path.resolve(postject, bin);
}
/**
 * Собирает bundle, внедряет blob в закреплённый официальный Node и проверяет версию.
 * Публикация в outDir разрешена только после проверки с пустым окружением.
 */
export async function buildCliBinary(input: CliSeaBuild): Promise<void> {
    const { packageDir, program, entry, options } = input;

    const platform = seaHostTarget();
    const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
    const runtime = await readTargetNodeRuntime(componentNodeRuntimeManifest(packageDir, platform), platform);
    const archive = await ensureNodeArchive(runtime, options.cacheDir, {
        download: downloadFile
    });
    const { directory } = nodeArchive(runtime);
    const postject = await postjectCli(packageDir);
    const target = path.join(options.outDir, program);

    await assertUntracked(target);
    await withWorkDirectory(options.cacheDir, async (work) => {
        const result = await input.bundle({
            entryPoints: [path.join(packageDir, 'src', entry)],
            outfile: path.join(work, 'bundle.cjs'),
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node24',
            logLevel: 'silent',
        });

        if (result.warnings.length > 0) {
            throw new Error(result.warnings.map((warning) => warning.text).join('\n'));
        }

        await run('tar', [
            '-xJf', archive, '-C', work, '--strip-components=1',
            `${directory}/bin/node`, `${directory}/LICENSE`,
        ]);
        await writeFile(path.join(work, 'sea-config.json'), JSON.stringify(seaConfig()));
        await run(path.join(work, 'bin/node'), ['--experimental-sea-config', 'sea-config.json'], {
            cwd: work
        });
        await copyFile(path.join(work, 'bin/node'), path.join(work, program));
        await injectSea({
            target: platform,
            work,
            node: process.execPath,
            postject,
            executable: program,
            fuse: SEA_FUSE,
            run: (file, args, options) => run(file, args, { ...options, maxBuffer: 4 * 1024 * 1024 }),
        });
        await chmod(path.join(work, program), 0o755);

        const version = await run(path.join(work, program), ['--version'], {
            env: {},
            timeout: 10000,
        });
        const runtimeLabel = platform.replace('-', ' ');
        const expected = `${program} ${manifest.version} (Node v${runtime.version}, ${runtimeLabel})\n`;

        if (version.stdout !== expected || version.stderr !== '') {
            throw new Error('версия готового ' + program + ' не совпадает с manifest');
        }

        await publishFile(path.join(work, program), target);
    });
    process.stdout.write(
        `${target}\n${(await stat(target)).size} байт\nsha256 ${await sha256File(target)}\n`,
    );
}
