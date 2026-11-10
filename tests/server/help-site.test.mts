import { collectLicenses } from '../../server/scripts/sea/dependencies.mts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileHelpSources } from '../../shared/node/helpSources.ts';
import { buildHelpSite } from '../../server/scripts/help/buildHelpSite.mts';

test('HELP-W1: реальный static build содержит тот же корпус, штатные ссылки и license inputs', async (t) => {
  const root = path.resolve(import.meta.dirname, '../..');
  const output = await mkdtemp(path.join(os.tmpdir(), 'help-site-'));
  const corpus = await compileHelpSources(root, {
    version: '0.1.0', commit: 'c'.repeat(40)
  });

  t.after(() => rm(output, {
    recursive: true, force: true
  }));

  const packages = await buildHelpSite({
    sourceRoot: root,
    output,
    bundle: corpus
  });
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
