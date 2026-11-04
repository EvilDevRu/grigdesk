import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compileHelpSources } from '../../../shared/node/helpSources.ts';
import { buildHelpSite } from './buildHelpSite.mts';

const execute = promisify(execFile);
/**
 * Корпус и static reader готовятся только внутри нового staging сервера.
 * Ошибка источника или reader не затрагивает установленный ELF и прежний R.
 */
export async function writeHelpResources(input: {
  sourceRoot: string;
  directory: string;
}, site = buildHelpSite): Promise<string[]> {
  const version = (await readFile(path.join(input.sourceRoot, 'VERSION'), 'utf8')).trim();
  const commit = await execute('git', ['rev-parse', 'HEAD'], {
    cwd: input.sourceRoot, timeout: 5000,
  }).then((result) => result.stdout.trim()).catch(() => 'source');
  const bundle = await compileHelpSources(input.sourceRoot, {
    version, commit
  });
  const directory = path.join(input.directory, 'server/help');

  await mkdir(directory, {
    recursive: true
  });
  await writeFile(path.join(directory, 'help.json'), JSON.stringify(bundle));

  const packages = await site({
    sourceRoot: input.sourceRoot,

    output: path.join(directory, 'site'),
    bundle
  });
  const published = await readFile(path.join(directory, 'site/help.json'), 'utf8');

  if (published !== JSON.stringify(bundle)) {
    throw new Error('help_site_mismatch');
  }

  return packages;
}
