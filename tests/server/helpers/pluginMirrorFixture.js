import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { installError } from '../../../server/src/lib/pluginInstall/errors.ts';
import { PluginSourceRegistry } from '../../../server/src/lib/pluginInstall/sources.ts';
import { serviceFixture } from './pluginServiceFixture.js';

/**
 * Mirror создаёт реальные деревья и полный source контракт с управляемыми версиями.
 * Service scenarios используют его для barrier/failure вместо внешней сети.
 */
export function fixtureMirror() {
  const versions = new Map();
  const calls = [];
  const source = {
    kind: 'mirror',
    normalizeUrl: (url) => {
      if (typeof url !== 'string' || !url.startsWith('mirror://fixture/')) {
        throw installError('source_url_invalid');
      }

      return url;
    },
    listVersions: async () => [...versions.values()].map((value) => value.target).reverse(),
    fetch: async (request) => {
      calls.push(request);

      const version = versions.get(request.target.version);

      await mkdir(request.destination, { recursive: true });
      await writeFile(path.join(request.destination, 'plugin.json'), JSON.stringify({
        id: 'demo',
        version: request.target.version,
        ...version.manifest,
      }));

      for (const [file, content] of Object.entries(version.files)) {
        await mkdir(path.dirname(path.join(request.destination, file)), { recursive: true });
        await writeFile(path.join(request.destination, file), content);
      }
    },
    changes: async () => null,
    inspectInstalled: async (_dir, expected) => ({ sha: expected.sha, modified: false }),
  };

  /**
   * Версия получает постоянный SHA, не зависящий от времени теста.
   * Files и manifest копируются, чтобы fixture caller не менял опубликованную версию.
   */
  function release(version, { manifest = {}, files = {} } = {}) {
    const sha = (versions.size + 1).toString(16).repeat(40);

    versions.set(version, {
      target: {
        version,
        tag: `v${version}`,
        sha,
      },
      manifest: structuredClone(manifest),
      files: structuredClone(files),
    });
  }

  return {
    source,
    versions,
    calls,
    release,
  };
}

/**
 * Две установки идут через service, а не вручную собранные неполные records.
 * На выходе current/previous payload и revision имеют реальную публикацию.
 */
export async function mirrorPair(t, { single = false, npm = false, ...overrides } = {}) {
  const mirror = fixtureMirror();

  const dependencies = npm ? {
    'package.json': '{"name":"fixture","version":"1.0.0"}',
    'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}',
  } : {};

  mirror.release('1.0.0', { files: { 'payload.txt': 'version1', ...dependencies } });
  mirror.release('1.1.0', { files: { 'payload.txt': 'version2', ...dependencies } });

  const fixture = await serviceFixture(t, {
    sources: new PluginSourceRegistry([mirror.source]),
    ...overrides,
  });

  for (const version of single ? ['1.0.0'] : ['1.0.0', '1.1.0']) {
    await fixture.service.startInstall({ url: 'mirror://fixture/demo', version });
    await fixture.service.whenIdle();

    const ready = await fixture.service.currentJob();

    if (ready.status !== 'ready') {
      throw new Error(`Fixture preparation: ${ready.error?.code}`);
    }

    const done = await fixture.service.apply(ready.id, ready.reviewToken);

    if (done.status !== 'done') {
      throw new Error(`Fixture apply: ${done.status}`);
    }
  }

  return { ...fixture, mirror };
}
