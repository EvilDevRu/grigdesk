import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { createRegistryPlugin, type BuildOptions } from '../../../server/scripts/sea/bundle.mts';
import { createModuleUrlsPlugin } from '../../../server/scripts/sea/moduleUrls.mts';

const probe = import.meta.dirname;
const root = path.resolve(probe, '../../..');
const runtime = process.argv[2];

if (!runtime || !path.isAbsolute(runtime)) {
  throw new Error('Нужен абсолютный каталог staging для Android-пробы.');
}

const runtimeModule = path.join(root, 'server/src/lib/runtimePaths.ts');
const contextModule = path.join(root, 'server/src/lib/runtimeBuildContext.ts');
const require = createRequire(path.join(root, 'server/package.json'));
const { build }: { build: (options: BuildOptions) => Promise<unknown> } = require('esbuild');
const bundle = path.join(runtime, 'server-bundle.cjs');

await build({
  absWorkingDir: root,
  entryPoints: ['server/src/app.ts'],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  packages: 'external',
  plugins: [
    {
      name: 'android-probe-context',
      setup(builder) {
        builder.onLoad({ filter: /runtimeBuildContext\.ts$/ }, (args) => {
          if (args.path !== contextModule) {
            return null;
          }

          return {
            contents: `
              export function runtimeBuildContext() {
                return { mode: 'source', root: __dirname, execPath: process.execPath };
              }
            `,
            loader: 'ts',
          };
        });
      },
    },
    createRegistryPlugin(root),
    createModuleUrlsPlugin({ root, runtimeModule }).plugin,
  ],
});

for (const file of ['VERSION', 'server/deepseek-runtime-contract.json',
  'server/build/helpers.json', 'server/build/node-runtime.json']) {
  const destination = path.join(runtime, file);

  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(root, file), destination, { recursive: true });
}

for (const name of ['package.json', 'package-lock.json']) {
  await cp(path.join(root, 'server', name), path.join(runtime, name));
}

const version = (await readFile(path.join(runtime, 'VERSION'), 'utf8')).trim();
const contentId = createHash('sha256').update(await readFile(bundle)).digest('hex');
const identity = {
  schema: 1,
  packagingVersion: 1,
  version,
  contentId,
};

await writeFile(path.join(runtime, 'release.json'), JSON.stringify(identity) + '\n');
