import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { build } from '../server/node_modules/esbuild/lib/main.js';
import {
  ensureNodeArchive, readTargetNodeRuntime, SEA_FUSE, seaHostTarget, serverNodeRuntimeManifest,
} from '../shared/node/nodeRuntime.ts';
import { downloadFile, injectSea, nodeArchive, seaConfig } from '../shared/node/seaBuild.ts';
import { copyInstallFile } from '../shared/node/binaryInstall.ts';
import { postjectCli } from '../server/scripts/sea/buildSteps.mts';
import { appendInstallerArchives } from '../shared/node/installerArchiveTail.ts';
import { stageDarwinProcessAssets } from '../shared/node/processIdentity.ts';

const execute = promisify(execFile);

/**
 * Maintenance содержит закреплённый Node, лицензию и автономный граф updater.
 * Хвост архивов поддерживается для исторического установщика Linux.
 */
export async function buildMaintenance(input: {
  root: string;
  outDir: string;
  cacheDir: string;
  assets?: Record<string, string>;
}): Promise<string> {
  const { server, desktop, ...assets } = input.assets ?? {};
  const target = seaHostTarget();

  if (Boolean(server) !== Boolean(desktop) || server && !assets.release) {
    throw new Error('installer_archive_pair_required');
  }

  if (target === 'darwin-arm64' && server && desktop) {
    throw new Error('installer_archive_tail_unsupported');
  }

  const manifest = path.join(input.root, serverNodeRuntimeManifest(target));
  const runtime = await readTargetNodeRuntime(manifest, target);
  const archive = await ensureNodeArchive(runtime, input.cacheDir, { download: downloadFile });

  await fs.mkdir(input.outDir, { recursive: true, mode: 0o700 });

  const work = await fs.mkdtemp(path.join(input.outDir, '.maintenance-'));

  try {
    const node = nodeArchive(runtime);
    const processAssets = target === 'darwin-arm64' ? await stageDarwinProcessAssets(work) : {};

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
    await fs.writeFile(path.join(work, 'sea-config.json'), JSON.stringify(seaConfig({
      ...assets,
      ...processAssets,
    })));
    await execute(path.join(work, 'bin/node'), ['--experimental-sea-config', 'sea-config.json'], {
      cwd: work,
      env: {},
    });
    await fs.copyFile(path.join(work, 'bin/node'), path.join(work, 'grigdesk-install'));
    await injectSea({
      target,
      work,
      node: path.join(work, 'bin/node'),
      postject: await postjectCli(path.join(input.root, 'server')),
      executable: 'grigdesk-install',
      fuse: SEA_FUSE,
      run: execute,
    });

    if (server && desktop) {
      await appendInstallerArchives(path.join(work, 'grigdesk-install'), { server, desktop });
    }

    const output = path.join(input.outDir, 'grigdesk-install');

    await copyInstallFile(path.join(work, 'grigdesk-install'), output);

    return output;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
