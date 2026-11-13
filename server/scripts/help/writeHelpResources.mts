import { readProductBuildVersion } from '../../../shared/node/releaseBuild.ts';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compileHelpSources } from '../../../shared/node/helpSources.ts';
import { HELP_LOCALES, helpResourceFile } from '../../../shared/help/helpContracts.ts';
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
  const bundles = await Promise.all(HELP_LOCALES.map((locale) =>
    compileHelpSources(input.sourceRoot, {
      version,
      commit,
    }, locale)));
  const bundle = bundles[0]!;
  const directory = path.join(input.directory, 'server/help');

  await mkdir(directory, {
    recursive: true
  });

  for (const entry of bundles) {
    await writeFile(path.join(directory, helpResourceFile(entry.locale)), JSON.stringify(entry));
  }

  const packages = await site({
    sourceRoot: input.sourceRoot,

    output: path.join(directory, 'site'),
    bundle,
    translations: bundles.slice(1),
  });

  for (const entry of bundles) {
    const published = await readFile(path.join(directory, 'site', helpResourceFile(entry.locale)), 'utf8');

    if (published !== JSON.stringify(entry)) {
      throw new Error('help_site_mismatch');
    }
  }

  return packages;
}
