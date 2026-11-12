import { readProductBuildVersion } from '../../../shared/node/releaseBuild.ts';
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
  const version = await readProductBuildVersion(input.sourceRoot);
  const commit = await execute('git', ['rev-parse', 'HEAD'], {
    cwd: input.sourceRoot, timeout: 5000,
  }).then((result) => result.stdout.trim()).catch(() => 'source');
  const bundle = await compileHelpSources(input.sourceRoot, {
    version, commit
  });
  const englishBundle = await compileHelpSources(input.sourceRoot, {
    version,
    commit
  }, 'en');
  const directory = path.join(input.directory, 'server/help');

  await mkdir(directory, {
    recursive: true
  });
  await writeFile(path.join(directory, 'help.json'), JSON.stringify(bundle));
  await writeFile(path.join(directory, 'help.en.json'), JSON.stringify(englishBundle));

  const packages = await site({
    sourceRoot: input.sourceRoot,

    output: path.join(directory, 'site'),
    bundle,
    englishBundle
  });

  for (const [name, corpus] of [['help.json', bundle], ['help.en.json', englishBundle]] as const) {
    const published = await readFile(path.join(directory, 'site', name), 'utf8');

    if (published !== JSON.stringify(corpus)) {
      throw new Error('help_site_mismatch');
    }
  }

  return packages;
}
