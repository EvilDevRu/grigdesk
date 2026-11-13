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
import { packagePayload } from '../../server/scripts/binary/packagePayload.mts';
import { consumePayloadArchive } from '../../server/src/binary/payload.ts';
import { HELP_LOCALES, helpResourceFile } from '../../shared/help/helpContracts.ts';

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
    translations?: Array<{ locale: string }>;
  }) => {
    await mkdir(input.output, {
      recursive: true
    });
    await writeFile(path.join(input.output, 'help.json'), JSON.stringify(input.bundle));

    for (const translation of input.translations ?? []) {
      const file = path.join(input.output, `help.${translation.locale}.json`);

      await writeFile(file, JSON.stringify(translation));
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
  assert.equal((await first.bundle('en')).locale, 'en');
  assert.equal((await next.bundle('en')).articles.find((article) => article.id === 'chats')?.title,
    'Conversations with agents');
  assert.equal((await next.bundle()).version, '0.2.0');
  assert.equal((await first.bundle()).version, original.version);

  const files = await auditStage(a, {
    required: ['server/help/site/index.html', ...HELP_LOCALES.flatMap((locale) => [
      `server/help/${helpResourceFile(locale)}`,
      `server/help/site/${helpResourceFile(locale)}`,
    ])],
  });

  assert.equal(files.some((entry) => /docs\/(?:local|plans)/u.test(entry.path)), false);

  const archive = path.join(out, 'payload.zip');
  const payload = await packagePayload({ directory: a, outputFile: archive });
  const restoredFiles = new Map<string, Buffer>();

  await consumePayloadArchive([await readFile(archive)], payload, (entry) => {
    const chunks: Uint8Array[] = [];

    return {
      write: (bytes) => chunks.push(bytes.slice()),
      close: () => restoredFiles.set(entry.path, Buffer.concat(chunks)),
      abort: () => chunks.splice(0),
    };
  });

  const restoredRoot = path.join(out, 'restored');

  for (const [file, bytes] of restoredFiles) {
    const target = path.join(restoredRoot, file);

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  const restored = createHelpService({ root: restoredRoot, kind: 'packaged' });

  for (const locale of HELP_LOCALES) {
    const file = helpResourceFile(locale);

    assert.deepEqual(await restored.bundle(locale), await first.bundle(locale));
    assert.deepEqual(restoredFiles.get(`server/help/${file}`), restoredFiles.get(`server/help/site/${file}`));
  }

  const missing = createHelpService({
    root: path.join(out, 'missing'), kind: 'packaged'
  });

  assert.deepEqual(await missing.invoke({
    action: 'index'
  }), {
    ok: false, error: 'help_unavailable'
  });
});


for (const locale of HELP_LOCALES) {
  test(`HELP-P2: изменение guide/${locale} после prepare останавливает package`, async (t) => {
    const root = path.resolve(import.meta.dirname, '../..');
    const out = await mkdtemp(path.join(os.tmpdir(), 'help-build-inputs-'));
    const source = path.join(out, 'source');
    const work = path.join(out, 'work');
    const expected = await readBuildInputs(root);

    for (const language of HELP_LOCALES) {
      assert.ok(expected[`docs/grigdesk/guide/${language}/catalog.json`]);
      assert.ok(expected[`docs/grigdesk/guide/${language}/chats.md`]);
    }

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
    await writeFile(path.join(source, `docs/grigdesk/guide/${locale}/chats.md`), '# Changed after prepare');
    await assert.rejects(() => promisify(execFile)(process.execPath, [
      path.join(root, 'server/scripts/binary/buildStage.mts'), 'package', input,
    ]), /Входные контракты сборки изменились/);
    await assert.rejects(() => readFile(path.join(work, 'prepared-manifest.json')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(out, 'grigdesk-server'), 'utf8'), 'PREVIOUS-ELF');
  });
}
