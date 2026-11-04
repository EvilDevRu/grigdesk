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
  }) => {
    await mkdir(input.output, {
      recursive: true
    });
    await writeFile(path.join(input.output, 'help.json'), JSON.stringify(input.bundle));
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
