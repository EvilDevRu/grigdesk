import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readBuildInputs } from '../../server/scripts/binary/buildSteps.mts';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeHelpResources } from '../../server/scripts/help/writeHelpResources.mts';
import { createHelpService } from '../../server/src/lib/help/service.ts';
import { makeReadOnlyTree } from '../../shared/node/files.ts';
import { auditStage } from '../../server/scripts/sea/stage.mts';
import { localeCorpus } from '../helpers/helpLocale.mts';
import { sha256 } from '../../shared/node/hash.ts';
import type { HelpBundle } from '../../shared/help/helpContracts.ts';

test('HELP-P1: packaged reader читает собственный A/B/A и не ищет внешний checkout', async (t) => {
  const root = path.resolve(import.meta.dirname, '../..');
  const out = await mkdtemp(path.join(os.tmpdir(), 'help-package-'));

  t.after(() => rm(out, {
    recursive: true, force: true
  }));

  /**
   * Fixture создаёт минимальный статический сайт из переданного корпуса.
   * Проверка ниже сравнивает ресурсные байты и отклоняет намеренное расхождение.
   */
  const generatedSite = async (input: {
    output: string;
    bundle: unknown;
    englishBundle?: unknown;
  }) => {
    await mkdir(input.output, {
      recursive: true
    });
    await writeFile(path.join(input.output, 'help.json'), JSON.stringify(input.bundle));

    if (input.englishBundle) {
      await writeFile(path.join(input.output, 'help.en.json'), JSON.stringify(input.englishBundle));
    }

    await writeFile(path.join(input.output, 'index.html'), '<!doctype html><title>Fixture reader</title>');

    return [];
  };
  const a = path.join(out, 'a');
  const b = path.join(out, 'b');

  await writeHelpResources({
    sourceRoot: root, directory: a
  }, generatedSite);
  await writeHelpResources({
    sourceRoot: root, directory: b
  }, generatedSite);

  await assert.rejects(() => writeHelpResources({
    sourceRoot: root,
    directory: path.join(out, 'mismatch'),
  }, async (input) => {
    await generatedSite(input);
    await writeFile(path.join(input.output, 'help.json'), '{}');

    return [];
  }), /help_site_mismatch/);

  const original = JSON.parse(await readFile(path.join(a, 'server/help/help.json'), 'utf8'));
  const altered = {
    ...original, version: '0.2.0'
  };
  const { canonicalJson } = await import('../../shared/lib/canonicalJson.ts');
  const { sha256 } = await import('../../shared/node/hash.ts');
  const { revision: _revision, ...content } = altered;

  altered.revision = sha256(canonicalJson(content));
  await writeFile(path.join(b, 'server/help/help.json'), JSON.stringify(altered));
  await makeReadOnlyTree(a);
  await makeReadOnlyTree(b);

  const first = createHelpService({
    root: a, kind: 'packaged'
  });
  const next = createHelpService({
    root: b, kind: 'packaged'
  });

  assert.equal((await first.bundle()).version, original.version);
  assert.equal((await next.bundle()).version, '0.2.0');
  assert.equal((await first.bundle()).version, original.version);

  const files = await auditStage(a, {
    required: ['server/help/help.json', 'server/help/site/index.html']
  });

  assert.equal(files.some((entry) => /docs\/(?:local|plans)/u.test(entry.path)), false);

  const missing = createHelpService({
    root: path.join(out, 'missing'), kind: 'packaged'
  });

  assert.deepEqual(await missing.invoke({
    action: 'index'
  }), {
    ok: false, error: 'help_unavailable'
  });
});


test('HELP-P2: изменение guide после prepare останавливает настоящую стадию package', async (t) => {
  const root = path.resolve(import.meta.dirname, '../..');
  const out = await mkdtemp(path.join(os.tmpdir(), 'help-build-inputs-'));
  const source = path.join(out, 'source');
  const work = path.join(out, 'work');
  const expected = await readBuildInputs(root);

  t.after(() => rm(out, { recursive: true, force: true }));

  for (const file of Object.keys(expected)) {
    const target = path.join(source, file);

    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, file), target);
  }

  assert.deepEqual(await readBuildInputs(source), expected);
  await mkdir(path.join(work, 'payload'), { recursive: true });
  await writeFile(path.join(work, 'payload/VERSION'), '0.1.0');
  await makeReadOnlyTree(path.join(work, 'payload'));
  await writeFile(path.join(out, 'grigdesk-server'), 'PREVIOUS-ELF');

  const input = path.join(out, 'build-input.json');

  await writeFile(input, JSON.stringify({
    sourceRoot: source,
    work,
    cacheDir: path.join(out, 'cache'),
    archive: path.join(out, 'node.tar.xz'),
    buildInputs: expected,
  }));
  await writeFile(path.join(source, 'docs/grigdesk/guide/chats.md'), '# Изменено после prepare');
  await assert.rejects(() => promisify(execFile)(process.execPath, [
    path.join(root, 'server/scripts/binary/buildStage.mts'), 'package', input,
  ]), /Входные контракты сборки изменились/);
  await assert.rejects(() => readFile(path.join(work, 'prepared-manifest.json')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(out, 'grigdesk-server'), 'utf8'), 'PREVIOUS-ELF');
});


/**
 * Сайт получает ровно те корпуса, которые подготовил настоящий writer.
 * Фикстура не перечитывает guide и тем самым обнаруживает отсутствие EN на границе сборки.
 */
async function bilingualSite(input: {
  output: string;
  bundle: unknown;
  englishBundle?: unknown
}) {
  assert.ok(input.englishBundle, 'Writer должен передать englishBundle вместе с прежним bundle');
  await mkdir(input.output, { recursive: true });
  await writeFile(path.join(input.output, 'help.json'), JSON.stringify(input.bundle));
  await writeFile(path.join(input.output, 'help.en.json'), JSON.stringify(input.englishBundle));
  await writeFile(path.join(input.output, 'index.html'), '<title>Offline guide</title>');

  return [];
}

test('HELP-PACK-L1: writer создаёт обе byte-identical runtime/site пары одной identity', async (t) => {
  const root = path.resolve(import.meta.dirname, '../..');
  const output = await mkdtemp(path.join(os.tmpdir(), 'help-two-resources-'));

  t.after(() => rm(output, { recursive: true, force: true }));
  await writeHelpResources({ sourceRoot: root, directory: output }, bilingualSite);

  const bundles: HelpBundle[] = [];

  for (const name of ['help.json', 'help.en.json']) {
    const runtime = await readFile(path.join(output, 'server/help', name));
    const site = await readFile(path.join(output, 'server/help/site', name));

    assert.deepEqual(runtime, site);
    assert.ok(runtime.length <= 1024 * 1024);
    bundles.push(JSON.parse(runtime.toString()));
  }

  const [russian, english] = bundles;

  assert.ok(russian);
  assert.ok(english);
  assert.equal(russian.locale, 'ru');
  assert.equal(english.locale, 'en');
  assert.equal(russian.version, english.version);
  assert.equal(russian.commit, english.commit);
  assert.deepEqual(russian.articles.map(({ id, file, routes }) => ({
    id,
    file,
    routes,
  })),
    english.articles.map(({ id, file, routes }) => ({
      id,
      file,
      routes,
    })));
});

test('HELP-PACK-L2: только EN site mismatch останавливает writer', async (t) => {
  const root = path.resolve(import.meta.dirname, '../..');
  const output = await mkdtemp(path.join(os.tmpdir(), 'help-en-mismatch-'));

  t.after(() => rm(output, { recursive: true, force: true }));
  await assert.rejects(() => writeHelpResources({ sourceRoot: root, directory: output }, async (input) => {
    await mkdir(input.output, { recursive: true });
    await writeFile(path.join(input.output, 'help.json'), JSON.stringify(input.bundle));
    await writeFile(path.join(input.output, 'help.en.json'), '{}');

    return [];
  }), /help_site_mismatch/u);
});

test('HELP-PACK-L1: read-only A/B/A выбирает собственные RU/EN и целые identity', async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'help-release-locales-'));

  t.after(() => rm(output, { recursive: true, force: true }));

  const services: ReturnType<typeof createHelpService>[] = [];

  for (const version of ['0.1.0', '0.2.0']) {
    const root = path.join(output, version);

    await mkdir(path.join(root, 'server/help'), { recursive: true });

    for (const locale of ['ru', 'en'] as const) {
      const name = locale === 'ru' ? 'help.json' : 'help.en.json';

      await writeFile(path.join(root, 'server/help', name), JSON.stringify(localeCorpus(locale, version)));
    }

    await makeReadOnlyTree(root);
    services.push(createHelpService({ root, kind: 'packaged' }));
  }

  for (const index of [0, 1, 0]) {
    for (const locale of ['ru', 'en'] as const) {
      const service = services[index]!;
      const actual = await Reflect.apply(service.bundle, service, [locale]);

      assert.deepEqual(actual, localeCorpus(locale, index === 0 ? '0.1.0' : '0.2.0'));
    }
  }
});

for (const defect of ['sha', 'locale']) {
  test(`HELP-PACK-L1: EN ${defect} повреждён, RU цел и EN можно повторить`, async (t) => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'help-en-corruption-'));
    const directory = path.join(output, 'server/help');
    const good = localeCorpus('en');
    const bad = defect === 'sha' ? { ...good, revision: '0'.repeat(64) } : localeCorpus('ru');

    t.after(() => rm(output, { recursive: true, force: true }));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'help.json'), JSON.stringify(localeCorpus('ru')));
    await writeFile(path.join(directory, 'help.en.json'), JSON.stringify(bad));

    const service = createHelpService({ root: output, kind: 'packaged' });
    const read = (locale: string) => Reflect.apply(service.bundle, service, [locale]);

    await assert.rejects(() => read('en'), /help_unavailable/u);
    assert.deepEqual(await read('ru'), localeCorpus('ru'));
    await writeFile(path.join(directory, 'help.en.json'), JSON.stringify(good));
    assert.deepEqual(await read('en'), good);
  });
}

test('HELP-PACK-L2: en/chats.md входит в prepare inputs и изменение сохраняет прежний output', async (t) => {
  const root = path.resolve(import.meta.dirname, '../..');
  const output = await mkdtemp(path.join(os.tmpdir(), 'help-en-inputs-'));
  const source = path.join(output, 'source');
  const work = path.join(output, 'work');
  const initial = await readBuildInputs(root);

  t.after(() => rm(output, { recursive: true, force: true }));

  for (const file of Object.keys(initial)) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await copyFile(path.join(root, file), path.join(source, file));
  }

  const english = path.join(source, 'docs/grigdesk/guide/en/chats.md');

  await mkdir(path.dirname(english), { recursive: true });
  await writeFile(english, '# Chat working directory\nBefore prepare.');

  const expected = await readBuildInputs(source);

  assert.equal(expected['docs/grigdesk/guide/en/chats.md'],
    sha256(await readFile(english)));
  await mkdir(path.join(work, 'payload'), { recursive: true });
  await writeFile(path.join(work, 'payload/VERSION'), '0.1.0');
  await makeReadOnlyTree(path.join(work, 'payload'));
  await writeFile(path.join(output, 'grigdesk-server'), 'PREVIOUS-ELF');

  const input = path.join(output, 'build-input.json');

  await writeFile(input, JSON.stringify({
    sourceRoot: source,
    work,
    cacheDir: path.join(output, 'cache'),
    archive: path.join(output, 'node.tar.xz'),
    buildInputs: expected,
  }));
  await writeFile(english, '# Chat working directory\nAfter prepare.');
  await assert.rejects(() => promisify(execFile)(process.execPath, [
    path.join(root, 'server/scripts/binary/buildStage.mts'), 'package', input,
  ]), /Входные контракты сборки изменились/u);
  assert.equal(await readFile(path.join(output, 'grigdesk-server'), 'utf8'), 'PREVIOUS-ELF');
});
