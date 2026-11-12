import { collectLicenses } from '../../server/scripts/sea/dependencies.mts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileHelpSources } from '../../shared/node/helpSources.ts';
import { buildHelpSite } from '../../server/scripts/help/buildHelpSite.mts';
import vm from 'node:vm';
import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { sha256 } from '../../shared/node/hash.ts';
import type { HelpBundle } from '../../shared/help/helpContracts.ts';
import { latestScript } from '../../server/scripts/help/buildHelpSite.mts';

test('HELP-W1: реальный static build содержит тот же корпус, штатные ссылки и license inputs', async (t) => {
  const root = path.resolve(import.meta.dirname, '../..');
  const output = await mkdtemp(path.join(os.tmpdir(), 'help-site-'));
  const corpus = await compileHelpSources(root, {
    version: '0.1.0', commit: 'c'.repeat(40)
  });

  t.after(() => rm(output, {
    recursive: true, force: true
  }));

  const packages = await buildHelpSite(siteInput(root, output, corpus));
  const licenseStage = path.join(output, 'license-fixture');

  await mkdir(path.join(licenseStage, 'runtime/node'), { recursive: true });
  await mkdir(path.join(licenseStage, 'server/node_modules'), { recursive: true });
  await writeFile(path.join(licenseStage, 'runtime/node/LICENSE'), 'Node fixture license');

  const licenses = await collectLicenses(licenseStage, { extraPackages: packages });

  assert.ok(licenses.packages.some((entry) => entry.name === 'mermaid'));
  assert.ok(licenses.packages.some((entry) => entry.name === 'marked'));

  const actual = JSON.parse(await readFile(path.join(output, 'help.json'), 'utf8'));
  const html = await readFile(path.join(output, 'index.html'), 'utf8');

  assert.deepEqual(actual, corpus);
  assert.match(html, /\.\/assets\//u);
  assert.doesNotMatch(html, /\/api\/help|web\/src|localhost|\.state/u);
  assert.ok(packages.some((file) => file.endsWith('/node_modules/marked')));
  assert.ok(packages.some((file) => file.endsWith('/node_modules/mermaid')));

  const latest = await readFile(path.join(output, 'latest.js'), 'utf8');

  assert.match(latest, /api\/releases\/v1/u);
  assert.doesNotMatch(latest, /channel\.json/u);
});


test('HELP-READER-LATEST: redirect сохраняет locale/search/hash и выбирает подпись читателя', async () => {
  let redirected = '';
  const message = { textContent: '' };
  const calls: Array<{ url: string; credentials: string }> = [];

  await vm.runInNewContext(latestScript, {
    navigator: { language: 'de-DE' },
    document: { getElementById: () => message },
    localStorage: { getItem: () => null },
    URLSearchParams,
    AbortSignal,
    location: {
      pathname: '/help/latest.html',
      search: '?locale=en&reader=offline',
      hash: '#/help/chats#working-directory',
      replace: (value: string) => {
        redirected = value;
      },
    },
    fetch: async (url: string, options: { credentials: string }) => {
      calls.push({ url, credentials: options.credentials });

      return { ok: true, json: async () => ({
        format: 2,
        channel: 'release',
        latest: { payload: { version: '0.1.2' } },
      }) };
    },
  });
  assert.equal(redirected, './0.1.2/index.html?locale=en&reader=offline#/help/chats#working-directory');
  assert.match(message.textContent, /Opening/u);
  assert.deepEqual(calls, [{ url: '../api/releases/v1/release.json', credentials: 'omit' }]);
});


/**
 * EN фикстура сохраняет все id/file/routes реального каталога для проверки пары ресурсов.
 * Качество перевода проверяет S-L2; здесь важны подпись, локаль и побайтная доставка.
 */
function siteInput(sourceRoot: string, output: string, corpus: HelpBundle) {
  const { revision: _revision, ...content } = { ...corpus, locale: 'en' as const };
  const englishBundle = { ...content, revision: sha256(canonicalJson(content)) };

  return {
    sourceRoot,
    output,
    bundle: corpus,
    englishBundle,
  };
}

test('HELP-PACK-W1: реальная сборка reader содержит обе byte-identical пары и общие assets', async (t) => {
  const root = path.resolve(import.meta.dirname, '../..');
  const output = await mkdtemp(path.join(os.tmpdir(), 'help-site-en-'));
  const corpus = await compileHelpSources(root, { version: '0.1.0', commit: 'c'.repeat(40) });
  const input = siteInput(root, output, corpus);

  t.after(() => rm(output, { recursive: true, force: true }));
  await buildHelpSite(input);
  assert.ok((await readdir(output)).includes('help.en.json'), 'Сайт должен содержать отдельный EN ресурс');
  assert.equal(await readFile(path.join(output, 'help.en.json'), 'utf8'),
    JSON.stringify(input.englishBundle));
  assert.equal(await readFile(path.join(output, 'help.json'), 'utf8'), JSON.stringify(input.bundle));
});
