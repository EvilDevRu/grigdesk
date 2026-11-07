import { execFile } from 'node:child_process';
import { chmod, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { build } from 'esbuild';

import { downloadFile, nodeArchive, seaConfig } from '../../shared/node/seaBuild.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { withWorkDirectory } from '../../shared/node/files.ts';

import { versionLine } from '../src/cli.ts';
import { ensureNodeArchive, parseBuildArgs, publishFile, readNodeRuntime, SEA_FUSE } from './buildSteps.mts';

const run = promisify(execFile);
const relay = path.resolve(import.meta.dirname, '..');

/**
 * Собирает приложение и внедряет blob в закреплённый официальный Node.
 * Публикация разрешена только после проверки версии с пустым окружением.
 */
async function buildRelay(outDir: string): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Сборка посредника поддерживает только Linux x64');
  }

  const manifest = JSON.parse(await readFile(path.join(relay, 'package.json'), 'utf8'));
  const runtime = readNodeRuntime(
    JSON.parse(await readFile(path.join(relay, 'build/node-runtime.json'), 'utf8')),
  );
  const cache = path.join(relay, '.cache');
  const archive = await ensureNodeArchive(runtime, cache, { download: downloadFile });
  const { directory } = nodeArchive(runtime);
  const postject = path.join(relay, 'node_modules/postject');
  const postjectManifest = JSON.parse(await readFile(path.join(postject, 'package.json'), 'utf8'));
  const postjectBin = typeof postjectManifest.bin === 'string'
    ? postjectManifest.bin
    : postjectManifest.bin.postject;
  const postjectCli = path.resolve(postject, postjectBin);

  await withWorkDirectory(cache, async (work) => {
    const result = await build({
      entryPoints: [path.join(relay, 'src/sea.ts')],
      outfile: path.join(work, 'bundle.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      define: { RELAY_VERSION: JSON.stringify(manifest.version) },
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
      cwd: work,
    });
    await copyFile(path.join(work, 'bin/node'), path.join(work, 'grigdesk-relay'));
    await run(process.execPath, [
      postjectCli, 'grigdesk-relay', 'NODE_SEA_BLOB', 'sea-prep.blob', '--sentinel-fuse', SEA_FUSE,
    ], {
      cwd: work,
      maxBuffer: 4 * 1024 * 1024,
    });
    await chmod(path.join(work, 'grigdesk-relay'), 0o755);

    const version = await run(path.join(work, 'grigdesk-relay'), ['--version'], {
      env: {},
      timeout: 10000,
    });
    const expected = `${versionLine(manifest.version, `v${runtime.version}`, 'linux', 'x64')}\n`;

    if (version.stdout !== expected || version.stderr !== '') {
      throw new Error('Версия готового посредника не совпадает с manifest');
    }

    await publishFile(path.join(work, 'grigdesk-relay'), path.join(outDir, 'grigdesk-relay'));
  });

  const output = path.join(outDir, 'grigdesk-relay');

  process.stdout.write(`${output}\n${(await stat(output)).size} байт\nsha256 ${await sha256File(output)}\n`);
}

const parsed = parseBuildArgs(process.argv.slice(2), process.cwd(), relay);

if ('error' in parsed) {
  process.stderr.write(`${parsed.error}\n`);
  process.exitCode = 2;
} else {
  try {
    await buildRelay(parsed.outDir);
  } catch (error) {
    process.stderr.write(`Сборка посредника не удалась: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
