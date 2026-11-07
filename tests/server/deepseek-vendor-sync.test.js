import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  checkDeepSeekPatches,
  materializeDeepSeekSnapshot,
  prepareDeepSeekSync,
  publishDeepSeekSync as publishProductionSnapshot,
  serializeDeepSeekManifest,
  verifyDeepSeekSnapshot,
  verifyDeepSeekVendorMetadata,
} from '../../deepseek/scripts/deepseekVendorManifest.ts';
import { deepSeekBuildInputs } from '../../deepseek/scripts/buildRuntime.mts';
import { createDeepSeekVendorFixture as fixture } from '../helpers/deepseekVendor.mts';

const exec = promisify(execFile);

/**
 * Миниатюрный upstream проверяет алгоритм публикации без настоящего compiler workspace.
 * CLI не имеет этого injection: обязательный production gate проверяется отдельным случаем.
 */
async function publishDeepSeekSync(candidate) {
  return publishProductionSnapshot(candidate, {
    runCompiledGate: async () => {
      await fs.stat(path.join(candidate.stagingDir, 'upstream/packages/a/src/index.ts'));
      await fs.stat(path.join(candidate.stagingDir, 'upstream/packages/b/src/index.ts'));
    },
  });
}

test('sync требует полный SHA и не принимает плавающий ref', async (t) => {
  const input = await fixture(t);

  for (const commit of [undefined, '', 'master', 'latest', 'c291e79', '--help']) {
    await assert.rejects(prepareDeepSeekSync({ ...input, commit }), /полный SHA/u);
  }

  await assert.rejects(fs.stat(input.vendorDir), { code: 'ENOENT' });
});

test('импорт переносит exact commit и ресурсы, сохраняя рабочий файл source', async (t) => {
  const input = await fixture(t);

  await fs.writeFile(path.join(input.sourceDir, 'packages/a/src/index.ts'), 'UNCOMMITTED\n');

  const candidate = await prepareDeepSeekSync({ ...input, commit: input.sha });

  await assert.rejects(fs.stat(input.vendorDir), { code: 'ENOENT' });
  assert.equal(candidate.manifest.commit, input.sha);
  assert.equal(candidate.manifest.version, '0.1.5-rc.2');
  assert.match(candidate.manifest.dependencyLock.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(candidate.diff.added.length, 9);
  await publishDeepSeekSync(candidate);
  await verifyDeepSeekSnapshot(input.vendorDir);
  assert.equal(await fs.readFile(path.join(input.vendorDir, 'upstream/packages/a/src/index.ts'), 'utf8'),
    'export const value = 1;\n');
  assert.equal(await fs.readFile(path.join(input.vendorDir, 'upstream/packages/a/resource.yaml'), 'utf8'),
    'enabled: true\n');
  assert.equal(await fs.readFile(path.join(input.sourceDir, 'packages/a/src/index.ts'), 'utf8'),
    'UNCOMMITTED\n');
});

test('повтор SHA не даёт diff; новый SHA удаляет и меняет только опубликованные файлы', async (t) => {
  const input = await fixture(t);
  const first = await prepareDeepSeekSync({ ...input, commit: input.sha });

  await publishDeepSeekSync(first);

  const before = await fs.readFile(path.join(input.vendorDir, 'upstream.lock.json'));
  const same = await prepareDeepSeekSync({ ...input, commit: input.sha });

  assert.deepEqual(same.diff, {
    added: [],
    changed: [],
    deleted: [],
  });
  await publishDeepSeekSync(same);
  assert.deepEqual(await fs.readFile(path.join(input.vendorDir, 'upstream.lock.json')), before);
  await fs.unlink(path.join(input.sourceDir, 'packages/a/resource.yaml'));
  await fs.writeFile(path.join(input.sourceDir, 'packages/a/src/index.ts'), 'export const value = 2;\n');

  const secondSha = await input.commit();
  const second = await prepareDeepSeekSync({ ...input, commit: secondSha });

  assert.deepEqual(second.diff.deleted, ['packages/a/resource.yaml']);
  assert.deepEqual(second.diff.changed, ['packages/a/src/index.ts']);
  assert.deepEqual(await fs.readFile(path.join(input.vendorDir, 'upstream.lock.json')), before);
  await publishDeepSeekSync(second);
  await assert.rejects(fs.stat(path.join(input.vendorDir, 'upstream/packages/a/resource.yaml')), {
    code: 'ENOENT',
  });
});

test('чистый checkout без пустого patches directory проходит verify и повторный sync', async (t) => {
  const input = await fixture(t);

  await publishDeepSeekSync(await prepareDeepSeekSync({ ...input, commit: input.sha }));
  await fs.rmdir(path.join(input.vendorDir, 'patches'));
  await verifyDeepSeekSnapshot(input.vendorDir);

  const candidate = await prepareDeepSeekSync({ ...input, commit: input.sha });

  assert.deepEqual(candidate.diff.added, []);
  await publishDeepSeekSync(candidate);
});

test('кэш upstream готовится по manifest из локального Git или проверенной копии', async (t) => {
  const input = await fixture(t);
  const upstream = path.join(input.vendorDir, 'upstream');
  const seed = path.join(input.root, 'seed');
  const offline = async () => {
    throw new Error('Сеть не нужна: источник есть локально');
  };

  await publishDeepSeekSync(await prepareDeepSeekSync({ ...input, commit: input.sha }));
  await fs.cp(upstream, seed, { recursive: true });
  await fs.rm(upstream, { recursive: true });

  // В Git остаются manifest, патчи и лицензии: метаданные целы, исходников ещё нет.
  await verifyDeepSeekVendorMetadata(input.vendorDir);
  await assert.rejects(verifyDeepSeekSnapshot(input.vendorDir), /не подготовлены/u);
  await materializeDeepSeekSnapshot(input.vendorDir, { sourceDir: input.sourceDir, fetchSource: offline });
  await verifyDeepSeekSnapshot(input.vendorDir);

  await fs.writeFile(path.join(upstream, 'packages/a/src/index.ts'), 'tampered\n');
  await materializeDeepSeekSnapshot(input.vendorDir, { seedDir: seed, fetchSource: offline });
  assert.equal(await fs.readFile(path.join(upstream, 'packages/a/src/index.ts'), 'utf8'),
    'export const value = 1;\n');

  let fetched = 0;

  await fs.rm(upstream, { recursive: true });
  await materializeDeepSeekSnapshot(input.vendorDir, {
    fetchSource: async () => {
      fetched += 1;

      return input.sourceDir;
    },
  });
  assert.equal(fetched, 1, 'без локального источника commit берётся по сети');
  await verifyDeepSeekSnapshot(input.vendorDir);

  const leftovers = (await fs.readdir(input.root)).filter((name) => name.startsWith('.deepseek-upstream-'));

  assert.deepEqual(leftovers, []);
});

test('commit, не совпадающий с manifest, не попадает в кэш upstream', async (t) => {
  const input = await fixture(t);
  const lock = path.join(input.vendorDir, 'upstream.lock.json');

  await publishDeepSeekSync(await prepareDeepSeekSync({ ...input, commit: input.sha }));

  const manifest = JSON.parse(await fs.readFile(lock, 'utf8'));

  manifest.files.find((file) => file.path === 'packages/b/src/index.ts').sha256 = '0'.repeat(64);
  await fs.writeFile(lock, serializeDeepSeekManifest(manifest));
  await fs.rm(path.join(input.vendorDir, 'upstream'), { recursive: true });
  await assert.rejects(materializeDeepSeekSnapshot(input.vendorDir, { sourceDir: input.sourceDir }),
    /не соответствует manifest/u);
  await assert.rejects(fs.stat(path.join(input.vendorDir, 'upstream')), { code: 'ENOENT' });
});

test('manifest хранит строку на файл без повторённых причин и читается обратно тем же', async (t) => {
  const input = await fixture(t);

  await publishDeepSeekSync(await prepareDeepSeekSync({ ...input, commit: input.sha }));

  const text = await fs.readFile(path.join(input.vendorDir, 'upstream.lock.json'), 'utf8');
  const manifest = JSON.parse(text);

  assert.equal(serializeDeepSeekManifest(manifest), text);

  for (const file of manifest.files) {
    assert.equal(Object.hasOwn(file, 'reason'), false);
    assert.ok(text.includes(`\n    ${JSON.stringify(file)}`));
  }
});

test('входы сборки считаются по manifest без исходников и без патч-версии Node', async (t) => {
  const input = await fixture(t);

  await publishDeepSeekSync(await prepareDeepSeekSync({ ...input, commit: input.sha }));

  const withSources = await deepSeekBuildInputs(input.vendorDir);

  await fs.rm(path.join(input.vendorDir, 'upstream'), { recursive: true });
  assert.deepEqual(await deepSeekBuildInputs(input.vendorDir), withSources);
  assert.equal(JSON.stringify(withSources).includes(process.versions.node), false);
});

test('ручная правка, добавление, удаление и symlink старого снимка запрещают sync', async (t) => {
  const input = await fixture(t);
  const candidate = await prepareDeepSeekSync({ ...input, commit: input.sha });

  await publishDeepSeekSync(candidate);

  const file = path.join(input.vendorDir, 'upstream/packages/a/src/index.ts');
  const original = await fs.readFile(file);

  await fs.writeFile(file, 'HUMAN\n');
  await assert.rejects(prepareDeepSeekSync({ ...input, commit: input.sha }), /изменён вручную/u);
  assert.equal(await fs.readFile(file, 'utf8'), 'HUMAN\n');
  await fs.writeFile(file, original);

  const extra = path.join(input.vendorDir, 'upstream/untracked.txt');

  await fs.writeFile(extra, 'keep\n');
  await assert.rejects(prepareDeepSeekSync({ ...input, commit: input.sha }), /изменён вручную/u);
  await fs.unlink(extra);
  await fs.unlink(file);
  await assert.rejects(prepareDeepSeekSync({ ...input, commit: input.sha }), /изменён вручную/u);
  await fs.symlink(path.join(input.sourceDir, 'LICENSE'), file);
  await assert.rejects(prepareDeepSeekSync({ ...input, commit: input.sha }), /ссылка|Ссылка/u);
});

test('нет manifest внутри существующего vendor — не первичный импорт', async (t) => {
  const input = await fixture(t);

  await fs.mkdir(input.vendorDir);
  await fs.writeFile(path.join(input.vendorDir, 'human.txt'), 'keep\n');
  await assert.rejects(prepareDeepSeekSync({ ...input, commit: input.sha }));
  assert.equal(await fs.readFile(path.join(input.vendorDir, 'human.txt'), 'utf8'), 'keep\n');
});

test('traversal и символические ссылки source tree/назначения отвергаются', async (t) => {
  const input = await fixture(t);

  for (const name of ['../escape', '/tmp/escape', 'packages/../a', 'packages\\a', '.git/config']) {
    const selection = { ...input.selection, roots: [{ path: name, reason: 'Небезопасная фикстура' }] };

    await assert.rejects(prepareDeepSeekSync({
      ...input,
      selection,
      commit: input.sha,
    }), /путь/u);
  }

  await fs.symlink('/etc/passwd', path.join(input.sourceDir, 'packages/a/escape'));

  const commit = await input.commit();

  await assert.rejects(prepareDeepSeekSync({ ...input, commit }), /ссылку/u);
  await fs.symlink(input.sourceDir, input.vendorDir);
  await assert.rejects(prepareDeepSeekSync({ ...input, commit: input.sha }), /ссылка/u);
});

test('отсутствующие LICENSE, notices и dependency lock оставляют прежний snapshot целым', async (t) => {
  const input = await fixture(t);

  await publishDeepSeekSync(await prepareDeepSeekSync({ ...input, commit: input.sha }));

  const before = await fs.readFile(path.join(input.vendorDir, 'upstream.lock.json'));

  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'pnpm-lock.yaml']) {
    await fs.unlink(path.join(input.sourceDir, name));

    const commit = await input.commit();

    await assert.rejects(prepareDeepSeekSync({ ...input, commit }), /обязательный путь/u);
    assert.deepEqual(await fs.readFile(path.join(input.vendorDir, 'upstream.lock.json')), before);
  }
});

test('tampered candidate и изменение snapshot между prepare/publish запрещают публикацию', async (t) => {
  const input = await fixture(t);
  const first = await prepareDeepSeekSync({ ...input, commit: input.sha });

  await publishDeepSeekSync(first);

  const changed = await prepareDeepSeekSync({ ...input, commit: input.sha });
  const original = path.join(input.vendorDir, 'upstream/packages/a/src/index.ts');

  await fs.writeFile(path.join(changed.stagingDir, 'upstream/packages/a/src/index.ts'), 'tampered\n');
  await assert.rejects(publishDeepSeekSync(changed), /Hash/u);
  assert.equal(await fs.readFile(original, 'utf8'), 'export const value = 1;\n');

  const race = await prepareDeepSeekSync({ ...input, commit: input.sha });

  await fs.writeFile(original, 'HUMAN\n');
  await assert.rejects(publishDeepSeekSync(race), /изменён вручную/u);
  assert.equal(await fs.readFile(original, 'utf8'), 'HUMAN\n');
});

test('patch применяется только к копии; конфликт и unsafe patch не изменяют source', async (t) => {
  const input = await fixture(t);
  const patchesDir = path.join(input.root, 'patches');

  await fs.mkdir(patchesDir);

  const patch = [
    'diff --git a/packages/a/src/index.ts b/packages/a/src/index.ts',
    '--- a/packages/a/src/index.ts',
    '+++ b/packages/a/src/index.ts',
    '@@ -1 +1 @@',
    '-export const value = 1;',
    '+export const value = 10;',
    '',
  ].join('\n');

  await fs.writeFile(path.join(patchesDir, '001-bridge.patch'), patch);

  const candidate = await prepareDeepSeekSync({
    ...input,
    patchesDir,
    commit: input.sha,
  });

  await publishDeepSeekSync(candidate);

  const build = path.join(input.root, 'build');

  await checkDeepSeekPatches(input.vendorDir, build);
  assert.equal(await fs.readFile(path.join(build, 'packages/a/src/index.ts'), 'utf8'),
    'export const value = 10;\n');
  assert.equal(await fs.readFile(path.join(input.vendorDir, 'upstream/packages/a/src/index.ts'), 'utf8'),
    'export const value = 1;\n');

  const before = await fs.readFile(path.join(input.vendorDir, 'upstream.lock.json'));

  await fs.writeFile(path.join(input.sourceDir, 'packages/a/src/index.ts'), 'export const value = 2;\n');

  const commit = await input.commit();

  await assert.rejects(prepareDeepSeekSync({ ...input, commit }), /Конфликт/u);
  assert.deepEqual(await fs.readFile(path.join(input.vendorDir, 'upstream.lock.json')), before);
  await fs.writeFile(path.join(patchesDir, '001-bridge.patch'), patch.replaceAll(
    'packages/a/src/index.ts', '../escape',
  ));
  await assert.rejects(prepareDeepSeekSync({
    ...input,
    patchesDir,
    commit: input.sha,
  }), /небезопасный/u);
  await assert.rejects(fs.stat(path.join(input.root, 'escape')), { code: 'ENOENT' });
});

test('export-subst не может изменить байты upstream под тем же commit', async (t) => {
  const input = await fixture(t);

  await fs.writeFile(path.join(input.sourceDir, '.gitattributes'), 'packages/a/resource.yaml export-subst\n');
  await fs.writeFile(path.join(input.sourceDir, 'packages/a/resource.yaml'), '$Format:%H$\n');

  const commit = await input.commit();

  await assert.rejects(prepareDeepSeekSync({ ...input, commit }), /байты|blob/u);
});

test('mode-only diff виден до публикации и входит в identity снимка', async (t) => {
  const input = await fixture(t);

  await publishDeepSeekSync(await prepareDeepSeekSync({ ...input, commit: input.sha }));
  await fs.chmod(path.join(input.sourceDir, 'packages/a/src/index.ts'), 0o755);

  const commit = await input.commit();
  const candidate = await prepareDeepSeekSync({ ...input, commit });

  assert.deepEqual(candidate.diff.changed, ['packages/a/src/index.ts']);
});

test('неизвестный или потерянный gate не допускает обновление', async (t) => {
  const input = await fixture(t);
  const candidate = await prepareDeepSeekSync({ ...input, commit: input.sha });

  candidate.manifest.requiredGates.push('future-required-gate');
  await fs.writeFile(path.join(candidate.stagingDir, 'upstream.lock.json'),
    JSON.stringify(candidate.manifest));
  await assert.rejects(publishDeepSeekSync(candidate), /gate/u);
  await assert.rejects(fs.stat(input.vendorDir), { code: 'ENOENT' });

  candidate.manifest.requiredGates.pop();
  candidate.manifest.requiredGates.push('compiled-parity');
  await fs.writeFile(path.join(candidate.stagingDir, 'upstream.lock.json'),
    JSON.stringify(candidate.manifest));
  await assert.rejects(publishProductionSnapshot(candidate, {
    runCompiledGate: async () => {
      throw new Error('compiled-parity gate отсутствует в фикстуре');
    },
  }), /gate отсутствует/u);
});

test('публикация не переносит незарегистрированные файлы верхнего уровня candidate', async (t) => {
  const input = await fixture(t);
  const candidate = await prepareDeepSeekSync({ ...input, commit: input.sha });

  await fs.writeFile(path.join(candidate.stagingDir, 'unexpected-launcher.mjs'), 'process.exit(0);\n');
  await assert.rejects(publishDeepSeekSync(candidate), /Состав|состав/u);
  await assert.rejects(fs.stat(input.vendorDir), { code: 'ENOENT' });
});

test('metadata symlink отвергается до чтения, version сверяется с исходником', async (t) => {
  const input = await fixture(t);
  const candidate = await prepareDeepSeekSync({ ...input, commit: input.sha });
  const license = path.join(candidate.stagingDir, 'LICENSE');

  await fs.unlink(license);
  await fs.symlink(path.join(input.sourceDir, 'LICENSE'), license);
  await assert.rejects(publishDeepSeekSync(candidate), /ссылка/u);
  await fs.unlink(license);
  await fs.copyFile(path.join(candidate.stagingDir, 'upstream/LICENSE'), license);
  candidate.manifest.version = '9.9.9';
  await fs.writeFile(path.join(candidate.stagingDir, 'upstream.lock.json'),
    JSON.stringify(candidate.manifest));
  await assert.rejects(publishDeepSeekSync(candidate), /version|Версия/u);
});

test('CLI готовит source и запрещает публикацию без compiled closure; current сохранён', async (t) => {
  const input = await fixture(t);
  const selection = path.join(input.root, 'selection.json');
  const recipe = path.join(input.root, 'candidate.json');
  const cli = new URL('../../deepseek/scripts/syncDeepSeekHarness.mts', import.meta.url).pathname;
  const runtime = path.join(input.root, 'runtime');

  await fs.mkdir(runtime);
  await fs.symlink('builds/old', path.join(runtime, 'current'));
  await fs.writeFile(selection, JSON.stringify(input.selection));

  const args = [cli, '--source-dir', input.sourceDir, '--commit', input.sha,
    '--vendor-dir', input.vendorDir, '--selection', selection,
    '--staging-parent', path.join(input.root, 'staging'), '--candidate', recipe];

  await exec(process.execPath, args);
  await assert.rejects(fs.stat(input.vendorDir), { code: 'ENOENT' });
  await assert.rejects(exec(process.execPath, [cli, '--commit', '0'.repeat(40), '--publish', recipe]));
  await assert.rejects(exec(process.execPath, [cli, '--commit', input.sha, '--publish', recipe]),
    /Command failed/u);
  await assert.rejects(fs.stat(input.vendorDir), { code: 'ENOENT' });
  await publishDeepSeekSync(JSON.parse(await fs.readFile(recipe, 'utf8')));
  await verifyDeepSeekSnapshot(input.vendorDir);
  assert.equal(await fs.readlink(path.join(runtime, 'current')), 'builds/old');
});
