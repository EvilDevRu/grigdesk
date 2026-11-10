import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendInstallerArchives, copyInstallerArchive, verifyInstallerArchive,
} from '../../shared/node/installerArchiveTail.ts';
import { installedBuild } from '../helpers/installedBuildFixture.mjs';
import { verifyReleaseInstaller } from '../../tools/installedPublication.mts';

/**
 * Обычный файл изображает ELF, два разных архива позволяют заметить неверный порядок.
 * Сверяются настоящие диапазоны и SHA, без заглушки файловых или потоковых операций.
 */
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-tail-'));
  const binary = path.join(directory, 'installer');
  const sources = {};
  const archives = {};
  const contents = { server: Buffer.from('server archive'), desktop: Buffer.from('desktop archive bytes') };

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(binary, Buffer.alloc(128, 42));

  for (const component of ['server', 'desktop']) {
    sources[component] = path.join(directory, component);
    await fs.writeFile(sources[component], contents[component]);
    archives[component] = {
      size: contents[component].length,
      sha256: createHash('sha256').update(contents[component]).digest('hex'),
    };
  }

  return {
    directory,
    binary,
    sources,
    archives,
    contents,
  };
}

test('installer tail: оба архива читаются точно, префикс ELF сохраняется', { timeout: 5000 }, async (t) => {
  const h = await fixture(t);

  await appendInstallerArchives(h.binary, h.sources);

  for (const component of ['server', 'desktop']) {
    const target = path.join(h.directory, component + '-copy');

    await verifyInstallerArchive(h.binary, h.archives, component);
    await copyInstallerArchive(h.binary, h.archives, component, target);
    assert.deepEqual(await fs.readFile(target), h.contents[component]);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  }

  assert.deepEqual((await fs.readFile(h.binary)).subarray(0, 128), Buffer.alloc(128, 42));
});

test('installer tail: порча SHA не оставляет опубликованный архив', { timeout: 5000 }, async (t) => {
  const h = await fixture(t);

  await appendInstallerArchives(h.binary, h.sources);

  const file = await fs.open(h.binary, 'r+');

  await file.write(Buffer.from('X'), 0, 1, 130);
  await file.close();
  await assert.rejects(verifyInstallerArchive(h.binary, h.archives, 'server'), /integrity_invalid/);

  const target = path.join(h.directory, 'invalid-copy');

  await assert.rejects(copyInstallerArchive(h.binary, h.archives, 'server', target), /integrity_invalid/);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  await verifyInstallerArchive(h.binary, h.archives, 'desktop');
});

test('installer tail: обрыв и добавленные байты не сдвигают доверенные границы молча',
  { timeout: 5000 }, async (t) => {
    for (const change of ['truncate', 'append']) {
      const h = await fixture(t);

      await appendInstallerArchives(h.binary, h.sources);

      if (change === 'truncate') {
        await fs.truncate(h.binary, (await fs.stat(h.binary)).size - 1);
      } else {
        await fs.appendFile(h.binary, 'x');
      }

      await assert.rejects(verifyInstallerArchive(h.binary, h.archives, 'server'), /integrity_invalid/);
    }
  });

test('installer tail: неверные размеры и хеши не становятся диапазонами чтения', async (t) => {
  const h = await fixture(t);

  await appendInstallerArchives(h.binary, h.sources);

  for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const archives = structuredClone(h.archives);

    archives.server.size = size;
    await assert.rejects(verifyInstallerArchive(h.binary, archives, 'server'), /description_invalid/);
  }

  const archives = structuredClone(h.archives);

  archives.server.sha256 = 'invalid';
  await assert.rejects(verifyInstallerArchive(h.binary, archives, 'server'), /description_invalid/);
});

test('installer tail: ссылка источника запрещена, существующий target сохраняется', async (t) => {
  const h = await fixture(t);
  const link = path.join(h.directory, 'linked');

  await fs.symlink(h.sources.server, link);
  await assert.rejects(appendInstallerArchives(h.binary, { ...h.sources, server: link }), { code: 'ELOOP' });
  await appendInstallerArchives(h.binary, h.sources);

  const target = path.join(h.directory, 'existing');

  await fs.writeFile(target, 'keep');
  await assert.rejects(copyInstallerArchive(h.binary, h.archives, 'server', target), { code: 'EEXIST' });
  assert.equal(await fs.readFile(target, 'utf8'), 'keep');
});

test('installer: подпись привязана к точным байтам приватной исполняемой копии', async (t) => {
  const built = await installedBuild(t, 'release');
  const binary = path.join(built.directory, 'grigdesk-install');
  const proof = await fs.readFile(path.join(built.directory, 'grigdesk-install.sha256'), 'utf8');
  const signature = await fs.readFile(path.join(built.directory, 'grigdesk-install.sig'), 'utf8');

  await verifyReleaseInstaller(binary, built.index.latest, proof, signature, built.signer.publicKeyPem);
  await fs.chmod(binary, 0o600);
  await fs.appendFile(binary, 'changed');
  await assert.rejects(
    verifyReleaseInstaller(binary, built.index.latest, proof, signature, built.signer.publicKeyPem),
    /release_installer_signature_invalid/,
  );
});
