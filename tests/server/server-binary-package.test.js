import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditPayload } from '../../server/scripts/binary/buildPayload.mts';
import { bundleLauncher } from '../../server/scripts/binary/bundle.mts';
import { copyProductionDependencies } from '../../server/scripts/binary/offlineDependencies.mts';
import { runtimeSpecifiers, assertRuntimeDependencies } from '../../server/scripts/sea/dependencies.mts';

const options = {
  helperIds: ['fixture'],
  dependencies: ['fastify'],
  native: ['server/node_modules/native/build/Release/binding.node'],
};
const required = [
  'server/help/help.json', 'server/help/site/index.html', 'server/help/site/help.json',
  'VERSION', 'runtime/node/bin/node', 'runtime/node/bin/npm',
  'server/package.json', 'server/package-lock.json', 'server/payload.cjs',
  'server/worker-bootstrap.cjs', 'server/runtime/esmBridge.cjs',
  'server/runtime/helpers/helpers.json', 'server/runtime/helpers/fixture.mjs',
  'server/node_modules/fastify/package.json', ...options.native,
  'engine/bin/factory', 'engine/lib/core.sh',
  'tools/skills/grigdesk-connect-project/SKILL.md',
  'schemas/analytics/lifecycle-event.schema.json',
  'schemas/analytics/provider-lineage.schema.json', 'schemas/analytics/usage-document.schema.json',
  'deploy/require-vpn.sh', 'licenses/NODE.txt', 'licenses/THIRD-PARTY.json',
];

/**
 * Создаёт маленький замкнутый payload без чтения данных пользователя.
 * Каждый негативный case меняет только одно условие готовности поставки.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'server-package-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  for (const name of required) {
    await put(root, name);
  }

  return root;
}

/**
 * Пишет синтетические байты по относительному пути фикстуры.
 * Каталоги создаются внутри одноразового корня теста.
 */
async function put(root, name) {
  const file = path.join(root, name);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'fixture');
}

test('SB19: пропавшие helper, license, npm, native, schemas и навык запрещают payload', async (t) => {
  for (const name of required) {
    const root = await fixture(t);

    await rm(path.join(root, name));
    await assert.rejects(auditPayload(root, options), /обязательного файла/, name);
  }
});

test('SB19: внешний ELF, UI, свой TS, посторонний tools, секрет и наружная ссылка запрещены', async (t) => {
  for (const name of ['bin/deepseek', 'bin/b24', 'bin/grigdesk-relay', 'web/dist/index.html',
    'deepseek/runtime/node', 'server/grigdesk-server', 'server/src/leak.ts',
    'tools/maintenance.mts', '.env']) {
    const root = await fixture(t);

    await put(root, name);
    await assert.rejects(auditPayload(root, options), /Запрещ|исходник|состав/);
    await rm(path.join(root, name));
  }

  const root = await fixture(t);

  await symlink('/etc/passwd', path.join(root, 'server/outside'));
  await assert.rejects(auditPayload(root, options), /ссылк/);
});

test('SB19: vendor TS остаётся допустимым runtime библиотеки', async (t) => {
  const root = await fixture(t);

  await put(root, 'server/node_modules/fastify/src/types.ts');

  const files = await auditPayload(root, options);

  assert.ok(files.some((file) => file.path.endsWith('/src/types.ts')));
});

test('SB19: fflate встроен в launcher, остальные runtime импорты остаются строгими', async (t) => {
  const root = await fixture(t);
  const sourceRoot = path.resolve(import.meta.dirname, '../..');
  const result = await bundleLauncher({
    sourceRoot,
    outfile: path.join(root, 'launcher.cjs'),
    entryPoint: 'server/src/binary/payload.ts',
  });

  assert.ok(Object.keys(result.metafile.inputs).some((name) => name.includes('node_modules/fflate/')));

  const file = path.join(root, 'server/src/ordinary.ts');

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "import { Unzip } from 'fflate'; export { Unzip };\n");
  assert.throws(() => assertRuntimeDependencies({ dependencies: {} }, ['fflate']), /fflate/);
  assert.deepEqual(await runtimeSpecifiers(root, ['server/src']), ['fflate']);
});

test('SB19: приватные npm берутся строго по production lock, без установки и dev', async (t) => {
  const root = await fixture(t);
  const sourceRoot = path.join(root, 'input');
  const stageRoot = path.join(root, 'output');

  await put(sourceRoot, 'server/node_modules/library/index.js');
  await put(sourceRoot, 'server/node_modules/dev-only/index.js');
  await writeFile(path.join(sourceRoot, 'server/package.json'), '{}');
  await writeFile(path.join(sourceRoot, 'server/node_modules/library/package.json'),
    JSON.stringify({ name: 'library', version: '1.2.3' }));
  await writeFile(path.join(sourceRoot, 'server/package-lock.json'), JSON.stringify({ packages: {
    '': {},
    'node_modules/library': { version: '1.2.3' },
    'node_modules/dev-only': { version: '8.0.0', dev: true },
  } }));
  await copyProductionDependencies({ sourceRoot, stageRoot });

  const copied = await readFile(path.join(stageRoot, 'server/node_modules/library/index.js'), 'utf8')
    .catch(() => null);

  assert.equal(copied, 'fixture', 'production пакет должен быть скопирован');
  await assert.rejects(readFile(path.join(stageRoot, 'server/node_modules/dev-only/index.js')),
    { code: 'ENOENT' });
  await writeFile(path.join(sourceRoot, 'server/node_modules/library/package.json'),
    JSON.stringify({ name: 'library', version: '9.9.9' }));
  await assert.rejects(copyProductionDependencies({ sourceRoot, stageRoot }), /lock/);
});

test('SB19: shared-исходники в payload запрещены', async (t) => {
  const root = await fixture(t);

  await put(root, 'shared/runtime/legacyBrand.ts');

  await assert.rejects(auditPayload(root,
    { ...options, wrappers: ['shared/runtime/legacyBrand.ts'] }),
  /Запрещён корень состава payload|Лишний собственный исходник/u);
});
