import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sign } from 'node:crypto';

import { build } from '../../web/node_modules/esbuild/lib/main.js';
import { signedIndex } from './releaseV2Fixture.mjs';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../..');

/**
 * Изолированная сборка тестового модуля заменяет только pinned key и дорогие builders.
 * Новые runtime-механизмы, проверки подписи и работа с файлами остаются production-кодом.
 */
export async function loadInstalledModule(t, relative, publicKeyPem, stubs = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'installed-module-'));
  const output = path.join(directory, 'module.mjs');

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await build({
    entryPoints: [path.join(repository, relative)],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [{
      name: 'installed-fixture-ports',
      setup(builder) {
        builder.onLoad({ filter: /\.(?:ts|mts)$/ }, async ({ path: file }) => {
          const stub = stubs[path.relative(repository, file)];

          if (stub) {
            return {
              contents: stub,
              loader: 'ts',
              resolveDir: path.dirname(file),
            };
          }

          if (file.endsWith('/shared/runtime/releaseChannelContracts.ts')) {
            const source = await fs.readFile(file, 'utf8');

            return {
              contents: source.replace(/export const RELEASE_SIGNING_PUBLIC_KEY = [^;]+;/u,
                `export const RELEASE_SIGNING_PUBLIC_KEY = ${JSON.stringify(publicKeyPem)};`),
              loader: 'ts',
              resolveDir: path.dirname(file),
            };
          }

          return null;
        });
      },
    }],
  });

  return import(pathToFileURL(output).href);
}

/**
 * Настоящий bundle пишет подписанные tar и индекс в отдельном git-проекте фикстуры.
 * Компиляторы и SEA builder заменены, admission вызывается и фиксируется отдельно.
 */
export async function installedBuild(t, channel, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'installed-build-'));
  const root = path.join(temporary, 'source');
  const signer = signedIndex({ channel });
  const version = signer.identity.version;
  const captured = [];
  const admission = [];

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(path.join(root, 'VERSION'), '0.3.0\n');
  await execute('git', ['init', '-q', root]);
  await execute('git', ['add', 'VERSION'], { cwd: root });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'Фикстура выпуска'], { cwd: root });

  const builders = {};

  for (const name of ['server', 'window', 'b24', 'relay', 'deepseek']) {
    builders[name] = async (input) => {
      if (options.failBuilder === name) {
        throw new Error(`fixture_builder_failed:${name}`);
      }

      captured.push({
        name,
        env: { ...input.env },
        outDir: input.outDir,
      });

      const metadata = name === 'server' ? { version, packageId: 'b'.repeat(64) }
        : { version, releaseId: input.env.GRIGDESK_RELEASE_ID };
      const output = path.join(input.outDir, name);

      const source = name === 'server' && options.serverSource
        ? await options.serverSource(input, metadata)
        : '#!/bin/sh\nprintf \'%s\\n\' \'' + JSON.stringify(metadata) + '\'\n';

      await fs.writeFile(output, source, { mode: 0o755 });

      return output;
    };
  }

  const { executeInstalledBundle } = await loadInstalledModule(t, 'tools/installedBundle.mts',
    signer.publicKeyPem, {
      'tools/build-maintenance.mts': [
        "import fs from 'node:fs/promises';",
        "import path from 'node:path';",
        'export async function buildMaintenance(input) {',
        "  await fs.writeFile(path.join(input.outDir, 'grigdesk-install'),",
        "    'готовый helper', { mode: 0o555 });",
        '}',
      ].join('\n'),
    });

  await executeInstalledBundle({
    root,
    builders,
    env: { GRIGDESK_RELEASE_CHANNEL: channel, GRIGDESK_RELEASE_VERSION: version },
    sign: async (text) => sign(null, Buffer.from(text), signer.privateKey).toString('base64'),
    verifyDeepSeek: async () => {
      admission.push('verify');
    },
    verifyDeepSeekCompatibility: async () => {
      admission.push('compatibility');
    },
  });

  const directory = path.join(root, 'release-artifacts');
  const index = JSON.parse(await fs.readFile(path.join(directory, `${channel}.json`), 'utf8'));

  return {
    temporary,
    root,
    directory,
    index,
    captured,
    admission,
    signer,
  };
}
