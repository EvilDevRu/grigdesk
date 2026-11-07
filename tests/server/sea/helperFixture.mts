import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildHelper, loadHelpers } from '../../../server/scripts/sea/helpers.mts';
import type { HelperDefinition } from '../../../server/scripts/sea/helpers.mts';
import { sha256File } from '../../../shared/node/hash.ts';
import { readNodeRuntime } from '../../../shared/node/nodeRuntime.ts';
import { nodeArchive } from '../../../shared/node/seaBuild.ts';

export const SOURCE_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const runFile = promisify(execFile);

/**
 * Собирает настоящие helper-ы под закреплённым runtime в одноразовый комплект.
 * Данные и выходы лежат в tmp; ссылка на npm допустима только в этой ранней фикстуре.
 */
export async function helperFixture(t: TestContext, ids: string[], extra: HelperDefinition[] = []) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-helpers-'));

  t.after(() => rm(temporary, { recursive: true, force: true }));

  const root = path.join(temporary, 'R with space');
  const helpers = path.join(root, 'server/runtime/helpers');
  const runtime = readNodeRuntime(JSON.parse(await readFile(
    path.join(SOURCE_ROOT, 'server/build/node-runtime.json'), 'utf8',
  )), 'server runtime');
  const archive = path.join(SOURCE_ROOT, 'tracker/.cache', nodeArchive(runtime).name);

  if (await sha256File(archive) !== runtime.sha256) {
    throw new Error('Повреждён кэш закреплённого Node');
  }

  await mkdir(path.join(root, 'runtime/node'), { recursive: true });
  await mkdir(helpers, { recursive: true });
  await runFile('tar', [
    '-xJf', archive, '-C', path.join(root, 'runtime/node'), '--strip-components=1',
    `${nodeArchive(runtime).directory}/bin/node`,
  ]);
  await copyFile(path.join(SOURCE_ROOT, 'server/package.json'), path.join(root, 'server/package.json'));
  await symlink(path.join(SOURCE_ROOT, 'server/node_modules'), path.join(root, 'server/node_modules'));

  const manifest = await loadHelpers(path.join(SOURCE_ROOT, 'server/build/helpers.json'), SOURCE_ROOT);

  manifest.helpers.push(...extra);
  await writeFile(path.join(helpers, 'helpers.json'), JSON.stringify(manifest));

  for (const id of ids) {
    await buildHelper({
      manifest,
      id,
      root: SOURCE_ROOT,
      outDir: helpers,
      workDir: path.join(temporary, 'build'),
    });
  }

  return {
    temporary,
    root,
    node: path.join(root, 'runtime/node/bin/node'),
    entry: (id: string) => path.join(helpers, `${id}.mjs`),
  };
}
