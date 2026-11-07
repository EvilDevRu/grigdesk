import { buildReleaseIdentity, type ReleaseChannel } from '../../shared/runtime/productReleaseVersion.ts';
import { readProductBuildVersion } from '../../shared/node/releaseBuild.ts';
import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';
import { prepareClientUi } from '../../tools/client-ui.mts';

const desktop = path.resolve(import.meta.dirname, '..');
const distribution = path.join(desktop, 'dist');
const splashFiles = ['index.html', 'style.css', 'background.png', 'wordmark.svg'];

/**
 * Сначала собирает неизменяемый интерфейс в отдельном staging, не затрагивая рабочий web/dist.
 * Только готовый комплект заменяет desktop dist; отказ сохраняет предыдущую сборку.
 */
async function buildDesktop(): Promise<void> {
  // Staging рядом с desktop/dist: замена идёт через rename, а он работает только в пределах
  // одной файловой системы; папка данных может лежать на другом диске.
  const version = await readProductBuildVersion(path.dirname(desktop));
  const identity = process.env.GRIGDESK_RELEASE_COMMIT && process.env.GRIGDESK_RELEASE_CHANNEL
    ? buildReleaseIdentity(process.env.GRIGDESK_RELEASE_CHANNEL as ReleaseChannel,
      version, process.env.GRIGDESK_RELEASE_COMMIT) : null;

  if (identity && identity.releaseId !== process.env.GRIGDESK_RELEASE_ID) {
    throw new Error('release_identity_invalid');
  }

  const staging = await mkdtemp(path.join(desktop, '.dist-staging-'));
  const output = path.join(staging, 'dist');
  const previous = path.join(staging, 'previous');

  let preserveStaging = false;

  try {
    await mkdir(output);

    await prepareClientUi({ destination: path.join(output, 'ui') });
    await build({
      entryPoints: [path.join(desktop, 'src/main.ts')],
      outfile: path.join(output, 'main.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['electron'],
      // Импортируемые CLI-модули проверяют свой URL до запуска главного процесса.
      // В CommonJS он должен указывать на готовый файл, а не исчезать при сборке.
      define: {
        'import.meta.url': 'grigdeskBundleUrl',
        __GRIGDESK_BUILD_IDENTITY__: JSON.stringify(identity),
      },
      banner: {
        js: [
          "'use strict';",
          "const grigdeskBundleUrl = require('node:url').pathToFileURL(__filename).href;",
        ].join('\n'),
      },
    });
    await build({
      entryPoints: [path.join(desktop, 'src/browser/browserPreload.ts')],
      outfile: path.join(output, 'browserPreload.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['electron'],
    });

    // Окно получает заранее сглаженный растр: уменьшение упаковочной иконки 512 px
    // самой панелью задач теряет сглаживание и делает края букв зубчатыми.
    await copyFile(path.join(desktop, 'build/window-icon.png'), path.join(output, 'icon.png'));
    await mkdir(path.join(output, 'splash'));

    for (const name of splashFiles) {
      await copyFile(path.join(desktop, 'assets/splash', name),
        path.join(output, 'splash', name));
    }

    let moved = false;

    try {
      await rename(distribution, previous);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    try {
      await rename(output, distribution);
    } catch (error) {
      if (moved) {
        try {
          await rename(previous, distribution);
        } catch (restoreError) {
          preserveStaging = true;

          throw new Error(`Предыдущая сборка сохранена в ${previous}`, { cause: restoreError });
        }
      }

      throw error;
    }
  } finally {
    if (!preserveStaging) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

await buildDesktop();
