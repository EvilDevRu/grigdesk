import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { build } from '../server/node_modules/esbuild/lib/main.js';
import { readNodeRuntime, ensureNodeArchive, SEA_FUSE } from '../shared/node/nodeRuntime.ts';
import { downloadFile, nodeArchive, seaConfig } from '../shared/node/seaBuild.ts';
import { copyInstallFile } from '../shared/node/binaryInstall.ts';
import { postjectCli } from '../server/scripts/sea/buildSteps.mts';

const execute = promisify(execFile);

/**
 * Maintenance ELF содержит собственный pinned Node, лицензию и автономный граф updater.
 * Installer дополнительно встраивает подписанное описание и готовые архивы компонентов.
 */
export async function buildMaintenance(input: {
  root: string;
  outDir: string;
  cacheDir: string;
  assets?: Record<string, string>;
}): Promise<string> {
  const runtime = readNodeRuntime(JSON.parse(await fs.readFile(
    path.join(input.root, 'server/build/node-runtime.json'), 'utf8',
  )), 'server/build/node-runtime.json');
  const archive = await ensureNodeArchive(runtime, input.cacheDir, { download: downloadFile });

  await fs.mkdir(input.outDir, { recursive: true, mode: 0o700 });

  const work = await fs.mkdtemp(path.join(input.outDir, '.maintenance-'));

  try {
    const node = nodeArchive(runtime);

    await execute('tar', ['-xJf', archive, '--strip-components=1',
      `${node.directory}/bin/node`, `${node.directory}/LICENSE`], { cwd: work });
    await build({
      entryPoints: [path.join(input.root, 'tools/maintenance.mts')],
      outfile: path.join(work, 'bundle.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      define: { 'import.meta.filename': '__filename' },
    });
    await fs.writeFile(path.join(work, 'sea-config.json'), JSON.stringify(seaConfig(input.assets)));
    await execute(path.join(work, 'bin/node'), ['--experimental-sea-config', 'sea-config.json'], {
      cwd: work,
      env: {},
    });
    await fs.copyFile(path.join(work, 'bin/node'), path.join(work, 'grigdesk-install'));
    await execute(path.join(work, 'bin/node'), [await postjectCli(path.join(input.root, 'server')),
      'grigdesk-install', 'NODE_SEA_BLOB', 'sea-prep.blob', '--sentinel-fuse', SEA_FUSE], { cwd: work });

    const output = path.join(input.outDir, 'grigdesk-install');

    await copyInstallFile(path.join(work, 'grigdesk-install'), output);

    return output;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
