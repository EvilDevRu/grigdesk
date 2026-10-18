import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validatePluginPackage } from '../../server/src/lib/pluginInstall/validatePackage.ts';
import { decodeUserPluginManifest, scanUserPlugins } from '../../server/src/lib/pluginsRegistry.ts';

const expected = {
  version: '1.0.0',
  expectedId: null,
  reservedIds: new Set(['code']),
  grigDeskVersion: '1.0.0',
};

/**
 * Каждый пакет живёт в отдельном временном каталоге и удаляется вместе с тестом.
 * Файлы создаются до вызова production validator, без подмены filesystem.
 */
async function fixture(t, manifest = { id: 'demo', version: '1.0.0' }, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-package-'));
  const dir = path.join(root, 'demo');

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(dir);

  if (manifest !== undefined && manifest !== false) {
    await writeFile(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  }

  for (const [relative, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await writeFile(path.join(dir, relative), body);
  }

  return { root, dir };
}

test('V1: обычный серверный пакет даёт manifest без npm и страницы', async (t) => {
  const { dir } = await fixture(t, undefined, { 'server.js': 'export default () => {};\n' });
  const result = await validatePluginPackage(dir, expected);

  assert.deepEqual(result, {
    id: 'demo',
    name: 'demo',
    version: '1.0.0',
    description: '',
    hasServer: true,
    webDir: null,
    npmDirs: [],
  });
});

test('V2: отсутствующий manifest имеет безопасный код', async (t) => {
  const { dir } = await fixture(t, false);

  await assert.rejects(validatePluginPackage(dir, expected), { code: 'manifest_missing' });
});

test('V3: manifest ограничен JSON-объектом и 64 КиБ', async (t) => {
  for (const body of ['[]', 'null', '{broken', JSON.stringify({ padding: 'x'.repeat(65536) })]) {
    const { dir } = await fixture(t);

    await writeFile(path.join(dir, 'plugin.json'), body);
    await assert.rejects(validatePluginPackage(dir, expected), { code: 'manifest_invalid' });
  }
});

test('V4: id проверяется до ready и не допускает прототипные ключи', async (t) => {
  for (const id of ['Bad Id', 'constructor', 'prototype', '__proto__', '', 'a'.repeat(42)]) {
    const { dir } = await fixture(t, { id, version: '1.0.0' });

    await assert.rejects(validatePluginPackage(dir, expected), { code: 'id_invalid' });
  }

  const reserved = await fixture(t, { id: 'code', version: '1.0.0' });
  const mismatch = await fixture(t, { id: 'other', version: '1.0.0' });

  await assert.rejects(validatePluginPackage(reserved.dir, expected), { code: 'id_reserved' });
  await assert.rejects(validatePluginPackage(mismatch.dir, { ...expected, expectedId: 'demo' }), {
    code: 'id_mismatch',
  });
});

test('V5: api отсутствует или ровно 1, другие значения отвергаются', async (t) => {
  for (const api of [2, 0, '1', null]) {
    const { dir } = await fixture(t, {
      id: 'demo',
      version: '1.0.0',
      api,
    });

    await assert.rejects(validatePluginPackage(dir, expected), { code: 'api_unsupported' });
  }

  const { dir } = await fixture(t);

  assert.equal((await validatePluginPackage(dir, expected)).id, 'demo');
});

test('V6: version строго совпадает с выбранной стабильной версией', async (t) => {
  for (const version of ['v1.0.0', '1.0', '1.0.0-beta', ' 1.0.0 ', 100]) {
    const { dir } = await fixture(t, { id: 'demo', version });

    await assert.rejects(validatePluginPackage(dir, expected), { code: 'version_invalid' });
  }

  const { dir } = await fixture(t, { id: 'demo', version: '1.1.0' });

  await assert.rejects(validatePluginPackage(dir, expected), { code: 'version_mismatch' });
});

test('V7: minGrigDeskVersion проверяется и имеет безопасный detail', async (t) => {
  const newer = await fixture(t, {
    id: 'demo',
    version: '1.0.0',
    minGrigDeskVersion: '1.1.0',
  });
  const invalid = await fixture(t, {
    id: 'demo',
    version: '1.0.0',
    minGrigDeskVersion: 'tomorrow',
  });
  const equal = await fixture(t, {
    id: 'demo',
    version: '1.0.0',
    minGrigDeskVersion: '1.0.0',
  });

  await assert.rejects(validatePluginPackage(newer.dir, expected), {
    code: 'grigdesk_too_old',
    message: /нужна 1\.1\.0, установлена 1\.0\.0/u,
  });
  await assert.rejects(validatePluginPackage(invalid.dir, expected), {
    code: 'manifest_invalid',
    message: /minGrigDeskVersion должен быть вида X\.Y\.Z/u,
  });
  assert.equal((await validatePluginPackage(equal.dir, expected)).version, '1.0.0');
});

test('V8: web только подпапка с index.html, нормализация сохраняет контракт', async (t) => {
  for (const web of ['../x', '/etc', '.', './', 'web', 42, 'a/../../x', '\\etc']) {
    const { dir } = await fixture(t, {
      id: 'demo',
      version: '1.0.0',
      web,
    });

    await assert.rejects(validatePluginPackage(dir, expected), { code: 'web_invalid' });
  }

  const { dir } = await fixture(t, {
    id: 'demo',
    version: '1.0.0',
    web: 'browser/./',
  }, {
    'browser/index.html': '<title>demo</title>',
  });

  assert.equal((await validatePluginPackage(dir, expected)).webDir, 'browser');
});

test('V9: ссылки и спецфайлы отвергаются до чтения цели, FIFO не блокирует', async (t) => {
  const secret = await fixture(t);
  const secretFile = path.join(secret.root, 'private.json');
  const oldTime = new Date('2000-01-01T00:00:00Z');

  await writeFile(secretFile, JSON.stringify({
    id: 'demo',
    version: '1.0.0',
    name: 'fixture-secret',
  }));
  await utimes(secretFile, oldTime, oldTime);

  for (const location of ['root', 'ancestor', 'manifest', 'index', 'other']) {
    const { root, dir } = await fixture(t, {
      id: 'demo',
      version: '1.0.0',
      web: 'web',
    });
    let target = dir;

    await mkdir(path.join(dir, 'web'));
    await writeFile(path.join(dir, 'web/index.html'), 'page');

    if (location === 'root') {
      target = path.join(root, 'linked');
      await symlink(dir, target);
    } else if (location === 'ancestor') {
      await symlink(root, path.join(root, 'alias'));
      target = path.join(root, 'alias/demo');
    } else {
      const relative = location === 'manifest' ? 'plugin.json'
        : location === 'index' ? 'web/index.html' : 'other';

      await rm(path.join(dir, relative), { force: true });
      await symlink(secretFile, path.join(dir, relative));
    }

    await assert.rejects(validatePluginPackage(target, expected), (error) => {
      assert.equal(error.code, 'symlink_forbidden');
      assert.equal(error.message.includes('fixture-secret'), false);

      return true;
    });
    assert.equal((await lstat(secretFile)).atimeMs, oldTime.getTime(), 'цель не прочитана');
  }

  const fifo = await fixture(t);

  execFileSync('/usr/bin/mkfifo', [path.join(fifo.dir, 'pipe')]);
  await assert.rejects(validatePluginPackage(fifo.dir, expected), { code: 'package_unsupported' });

  const socket = await fixture(t);
  const server = net.createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path.join(socket.dir, 'socket'), resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(validatePluginPackage(socket.dir, expected), { code: 'package_unsupported' });
});

test('V10: подмодули и вложенная .git отвергаются', async (t) => {
  const modules = await fixture(t, undefined, { '.gitmodules': '[submodule "x"]' });
  const nested = await fixture(t, undefined, { 'browser/.git/config': '[core]' });

  await assert.rejects(validatePluginPackage(modules.dir, expected), { code: 'submodules_forbidden' });
  await assert.rejects(validatePluginPackage(nested.dir, expected), { code: 'package_unsupported' });
});

test('V11: реальные файлы ограничены суммарным числом и размером', async (t) => {
  const { dir } = await fixture(t, undefined, { 'one.txt': '12345', 'two.txt': '12345' });

  await assert.rejects(validatePluginPackage(dir, expected, {
    maxFiles: 2,
    maxBytes: 1e6,
    maxManifestBytes: 65536,
  }), { code: 'package_too_large' });
  await assert.rejects(validatePluginPackage(dir, expected, {
    maxFiles: 100,
    maxBytes: 5,
    maxManifestBytes: 65536,
  }), { code: 'package_too_large' });
});

const emptyPackage = JSON.stringify({ name: 'demo', version: '1.0.0' });
const emptyLock = JSON.stringify({
  name: 'demo',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: { '': { name: 'demo', version: '1.0.0' } },
});

test('V12: корневой lock выбирает npm, declarations требуют lock, orphan lock отвергнут', async (t) => {
  const paired = await fixture(t, undefined, {
    'package.json': emptyPackage,
    'package-lock.json': emptyLock,
  });
  const dependencies = await fixture(t, undefined, {
    'package.json': JSON.stringify({ dependencies: { synthetic: '1.0.0' } }),
  });
  const plain = await fixture(t, undefined, { 'package.json': emptyPackage });
  const orphan = await fixture(t, undefined, { 'package-lock.json': emptyLock });

  assert.deepEqual((await validatePluginPackage(paired.dir, expected)).npmDirs, ['.']);
  await assert.rejects(validatePluginPackage(dependencies.dir, expected), { code: 'lockfile_missing' });
  assert.deepEqual((await validatePluginPackage(plain.dir, expected)).npmDirs, []);
  await assert.rejects(validatePluginPackage(orphan.dir, expected), { code: 'npm_dir_invalid' });
});

test('V13: явные npmDirs нормализуются и требуют обе пары JSON', async (t) => {
  const files = {
    'package.json': emptyPackage,
    'package-lock.json': emptyLock,
    'browser/package.json': emptyPackage,
    'browser/package-lock.json': emptyLock,
  };
  const manifest = {
    id: 'demo',
    version: '1.0.0',
    install: { npm: ['.', 'browser', 'browser/./'] },
  };
  const valid = await fixture(t, manifest, files);

  assert.deepEqual((await validatePluginPackage(valid.dir, expected)).npmDirs, ['.', 'browser']);

  for (const npm of [['/etc'], ['../x'], [7], ['missing'], 'browser']) {
    const invalid = await fixture(t, { ...manifest, install: { npm } }, files);

    await assert.rejects(validatePluginPackage(invalid.dir, expected), { code: 'npm_dir_invalid' });
  }

  const noLock = await fixture(t, { ...manifest, install: { npm: ['browser'] } }, {
    'browser/package.json': emptyPackage,
  });

  await assert.rejects(validatePluginPackage(noLock.dir, expected), { code: 'lockfile_missing' });

  for (const install of [null, [], 'npm']) {
    const invalid = await fixture(t, { ...manifest, install });

    await assert.rejects(validatePluginPackage(invalid.dir, expected), { code: 'manifest_invalid' });
  }
});

test('V14: только доказанная clone metadata исключается из limits', async (t) => {
  const fake = await fixture(t, undefined, { '.git/large': 'x'.repeat(1024) });

  await assert.rejects(validatePluginPackage(fake.dir, expected), { code: 'package_unsupported' });

  const real = await fixture(t);

  execFileSync('/usr/bin/git', ['init', '--template=', real.dir], {
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdio: 'ignore',
  });
  await writeFile(path.join(real.dir, '.git/large'), 'x'.repeat(1024));

  assert.equal((await validatePluginPackage(real.dir, expected, {
    maxFiles: 1,
    maxBytes: 100,
    maxManifestBytes: 65536,
  })).id, 'demo');

  await rm(path.join(real.dir, '.git'), { recursive: true });
  await writeFile(path.join(real.dir, '.git'), 'gitdir: /elsewhere');
  await assert.rejects(validatePluginPackage(real.dir, expected), { code: 'package_unsupported' });
});

test('V15: конфиги npm, готовые зависимости, workspaces и старый lock отвергнуты', async (t) => {
  for (const relative of ['.npmrc', 'browser/.npmrc', 'npm-shrinkwrap.json', 'node_modules/item/file.js',
    'browser/node_modules/item/file.js', '.gitattributes', 'large.dat']) {
    const body = relative === '.gitattributes' ? '*.dat filter=host'
      : relative === 'large.dat' ? 'version https://git-lfs.github.com/spec/v1\noid sha256:fake\n' : 'x';
    const { dir } = await fixture(t, undefined, { [relative]: body });

    await assert.rejects(validatePluginPackage(dir, expected), { code: 'package_unsupported' });
  }

  const workspace = await fixture(t, undefined, {
    'package.json': JSON.stringify({ workspaces: ['browser'] }),
  });
  const oldLock = await fixture(t, undefined, {
    'package.json': emptyPackage,
    'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
  });

  await assert.rejects(validatePluginPackage(workspace.dir, expected), { code: 'package_unsupported' });
  await assert.rejects(validatePluginPackage(oldLock.dir, expected), { code: 'package_unsupported' });
});

test('V16: optional и peer учитываются, install.npm [] не скрывает runtime', async (t) => {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const install of [undefined, { npm: [] }]) {
      const manifest = {
        id: 'demo',
        version: '1.0.0',
        ...(install ? { install } : {}),
      };
      const { dir } = await fixture(t, manifest, {
        'package.json': JSON.stringify({ [field]: { synthetic: '1.0.0' } }),
      });

      await assert.rejects(validatePluginPackage(dir, expected), { code: 'lockfile_missing' });
    }
  }
});

test('V17: bounded JSON и вся политика declarations/lock graph проверяются до npm', async (t) => {
  for (const field of ['package.json', 'package-lock.json']) {
    for (const body of ['[]', 'null', '{broken', JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) })]) {
      const { dir } = await fixture(t, undefined, {
        'package.json': emptyPackage,
        'package-lock.json': emptyLock,
        [field]: body,
      });

      await assert.rejects(validatePluginPackage(dir, expected), { code: 'manifest_invalid' });
    }
  }

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const spec of ['git+ssh://host/repo', 'github:org/repo', 'file:../secret', 'link:../x',
      'workspace:*', 'https://registry.npmjs.org/pkg/-/pkg.tgz', '../x']) {
      const { dir } = await fixture(t, undefined, {
        'package.json': JSON.stringify({ [field]: { synthetic: spec } }),
        'package-lock.json': emptyLock,
      });

      await assert.rejects(validatePluginPackage(dir, expected), { code: 'package_unsupported' });
    }
  }

  for (const entry of [
    {
      version: '1.0.0',
      resolved: 'file:../x',
      integrity: 'sha512-YQ==',
    },
    {
      version: '1.0.0',
      resolved: 'https://evil.example/x',
      integrity: 'sha512-YQ==',
    },
    {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org.evil.example/x',
      integrity: 'sha512-YQ==',
    },
    {
      version: '1.0.0',
      resolved: 'https://user:secret@registry.npmjs.org/x',
      integrity: 'sha512-YQ==',
    },
    {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/x?credential=x',
      integrity: 'sha512-YQ==',
    },
    {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/x#part',
      integrity: 'sha512-YQ==',
    },
    { version: '1.0.0', resolved: 'https://registry.npmjs.org/x' },
    {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/x',
      integrity: 'not-integrity',
    },
    {
      version: '1.0.0',
      link: true,
      resolved: 'https://registry.npmjs.org/x',
      integrity: 'sha512-YQ==',
    },
  ]) {
    for (const flag of [{ dev: true }, { optional: true }]) {
      const { dir } = await fixture(t, undefined, {
        'package.json': emptyPackage,
        'package-lock.json': JSON.stringify({
          lockfileVersion: 3,
          packages: { '': {}, 'node_modules/synthetic': { ...entry, ...flag } },
        }),
      });

      await assert.rejects(validatePluginPackage(dir, expected), { code: 'package_unsupported' });
    }
  }

  const valid = await fixture(t, undefined, {
    'package.json': JSON.stringify({ dependencies: { synthetic: '^1.0.0' } }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 2,
      packages: {
        '': { dependencies: { synthetic: '^1.0.0' } },
        'node_modules/synthetic': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/synthetic/-/synthetic-1.0.0.tgz',
          integrity: 'sha512-YQ==',
        },
      },
    }),
  });

  assert.deepEqual((await validatePluginPackage(valid.dir, expected)).npmDirs, ['.']);
});

test('V20: общий decoder определяет одинаковые поля installer и scanner после публикации', async (t) => {
  const manifest = {
    id: 'demo',
    api: 1,
    version: '1.0.0',
    name: 'Демо',
    category: 'work',
    description: 'Проверяемый пакет',
    web: 'browser/./',
    nav: {
      path: '/demo',
      label: 'Демо',
      group: 'dock',
      icon: 'plugin',
      order: 17,
    },
    settings: [{
      key: 'limit',
      label: 'Лимит',
      type: 'number',
      default: 3,
    }],
    placements: [{ slot: 'provider.popover.after-bars', default: true }],
  };
  const { root, dir } = await fixture(t, manifest, { 'browser/index.html': '<title>Демо</title>' });
  const decoded = decodeUserPluginManifest(manifest);
  const validated = await validatePluginPackage(dir, expected);
  const [scanned] = await scanUserPlugins(root);

  assert.equal(decoded.id, validated.id);
  assert.equal(decoded.name, validated.name);
  assert.equal(decoded.webDir, validated.webDir);

  for (const field of ['id', 'api', 'version', 'name', 'description', 'nav', 'settings', 'placements']) {
    assert.deepEqual(scanned[field], decoded[field], field);
  }

  assert.equal(scanned.web.dir, path.join(dir, decoded.webDir));
});
