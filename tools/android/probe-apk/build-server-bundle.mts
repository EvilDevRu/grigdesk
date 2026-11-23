import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { rootCertificates } from 'node:tls';

import { createRegistryPlugin, type BuildOptions } from '../../../server/scripts/sea/bundle.mts';
import { createModuleUrlsPlugin } from '../../../server/scripts/sea/moduleUrls.mts';
import { copyResources, type ResourceManifest } from '../../../server/scripts/sea/resources.mts';

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

/**
 * Общий bundle знает корень из __dirname. Helper обработки медиа
 * лежит на четыре уровня глубже, как и его исходный вход.
 */
function probeContext(rootExpression: string): NonNullable<BuildOptions['plugins']>[number] {
  return {
    name: 'android-probe-context',
    setup(builder) {
      builder.onLoad({ filter: /runtimeBuildContext\.ts$/ }, (args) => {
        if (args.path !== contextModule) {
          return null;
        }

        return {
          contents: `
            import { fileURLToPath } from 'node:url';

            export function runtimeBuildContext() {
              return { mode: 'source', root: ${rootExpression}, execPath: process.execPath };
            }
          `,
          loader: 'ts',
        };
      });
    },
  };
}

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
    probeContext('__dirname'),
    createRegistryPlugin(root),
    createModuleUrlsPlugin({ root, runtimeModule }).plugin,
  ],
});

const speechHelpers = ['server/src/lib/media/ingestWorker.ts', 'server/src/lib/packageInstall/commandSupervisor.mjs'];

await Promise.all(speechHelpers.map((entry) => build({
  absWorkingDir: root,
  entryPoints: [entry],
  outfile: path.join(runtime, entry),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  plugins: [
    probeContext('fileURLToPath(new URL("../../../../", import.meta.url))'),
    createModuleUrlsPlugin({ root, runtimeModule, skip: [path.join(root, entry)] }).plugin,
  ],
})));

const resources: ResourceManifest = JSON.parse(await readFile(path.join(root, 'server/build/resources.json'), 'utf8'));
const speechResources = resources.entries.filter(({ source }) => (
  /^server\/(?:requirements-media.*\.txt|src\/lib\/(?:media|speech)\/[^/]+\.py)$/u.test(source)
));
const probeResources = [
  'server/src/lib/speech/android_whisper.py',
  'server/src/lib/speech/android-models.json',
];

await copyResources(root, runtime, {
  schema: 1,
  entries: [
    ...speechResources,
    ...probeResources.map((file) => ({ source: file, target: file, kind: 'file' as const })),
  ],
});
await writeFile(path.join(runtime, 'server/src/lib/speech/roots.pem'), rootCertificates.join('\n') + '\n');

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
