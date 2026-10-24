import assert from 'node:assert/strict';
import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { copyResources } from '../../server/scripts/sea/resources.mts';
import { auditStage } from '../../server/scripts/sea/stage.mts';
import { buildHelper, loadHelpers } from '../../server/scripts/sea/helpers.mts';
import { createRuntimePaths } from '../../server/src/lib/runtimePaths.ts';
import {
  ROOT, SAMPLE, fixture, scratch, put, requireSample, run, ok,
} from '../fixtures/pipelineSample.mjs';

test('SAMPLE-PACKAGE-01: source and relocated package discover the same sample', async (t) => {
  await requireSample();

  const moduleFile = path.join(ROOT, 'server/src/lib/pipelineSample.ts');

  assert.ok(await readFile(moduleFile).catch(() => null), 'К1: отсутствует серверный accessor образца');

  const { pipelineSampleDirectoryFor, pipelineSampleDirectory } = await import(pathToFileURL(moduleFile));
  const source = createRuntimePaths({
    mode: 'source',
    root: ROOT,
    execPath: process.execPath,
  });

  assert.equal(pipelineSampleDirectoryFor(source), SAMPLE);
  assert.equal(pipelineSampleDirectory(), SAMPLE);

  const root = await scratch(t);

  for (const name of ['resources.json', 'binary-resources.json']) {
    const manifest = JSON.parse(await readFile(path.join(ROOT, 'server/build', name), 'utf8'));
    const relative = 'server/seed/pipeline-sample';
    const stage = path.join(root, name);

    assert.ok(manifest.entries.some((entry) => entry.source === relative
      && entry.target === relative && entry.kind === 'dir'), `${name}: образец не включён`);
    await copyResources(ROOT, stage, manifest);

    const files = await auditStage(stage, { required: [`${relative}/profile/project.json`] });

    assert.ok(!files.some((file) => file.path.startsWith('profiles/')));
    assert.ok(!files.some((file) => file.path.startsWith('server/src/')
      && /\.(?:[cm]?[jt]s|map)$/u.test(file.path)));

    const binary = await put(stage, 'server/grigdesk-server', 'fixture');
    const installed = await put(root, 'installation/bin/grigdesk-server', 'fixture');
    const bundle = await put(stage, 'server/server.mjs', '// fixture');
    const modes = [
      createRuntimePaths({ mode: 'sea', execPath: binary }),
      createRuntimePaths({
        mode: 'payload',
        bundleFile: bundle,
        binary: installed,
      }),
    ];

    for (const paths of modes) {
      const selected = pipelineSampleDirectoryFor(paths);

      assert.equal(selected, path.join(stage, relative));
      assert.deepEqual(await readFile(path.join(selected, 'profile/project.json')),
        await readFile(path.join(SAMPLE, 'profile/project.json')));
    }

    for (const item of files.filter((file) => file.path.startsWith(relative) && file.path.endsWith('.md'))) {
      assert.ok((await readFile(path.join(stage, item.path), 'utf8')).trim());
    }
  }

  const config = run(process.execPath, ['--input-type=module', '-e',
    `const { config } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT,
      'server/src/config.ts')).href)}); process.stdout.write(config.pipelineSampleDir);`], {
    cwd: root,
    env: { GRIGDESK_HOME: path.join(root, 'home'), FACTORY_STATE_DIR: path.join(root, 'state') },
  });

  assert.equal(ok(config), SAMPLE);
});

test('SAMPLE-PACKAGE-02: packaged publisher uses bundled kit from another cwd', async (t) => {
  const f = await fixture(t);
  const manifest = await loadHelpers(path.join(ROOT, 'server/build/helpers.json'), ROOT);
  const built = await buildHelper({
    manifest,
    id: 'routes-publish-kit',
    root: ROOT,
    outDir: path.join(f.root, 'package/server/runtime/helpers'),
    workDir: path.join(f.root, 'build'),
  });
  const relocated = path.join(f.root, 'relocated-profile');

  await cp(f.profile, relocated, { recursive: true });

  const publisher = path.join(relocated, 'routes/publish.mjs');
  const env = { ...f.env, GRIGDESK_ROUTES_KIT: built.file };

  ok(run(process.execPath, [publisher, '--validate'], { cwd: f.root, env }));
  ok(run(process.execPath, [publisher, '--publish', '--base-dir', path.join(f.root, 'store'),
    '--expected-catalog-hash', 'null'], { cwd: f.root, env }));
});
