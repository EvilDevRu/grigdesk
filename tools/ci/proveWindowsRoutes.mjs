import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DraftStore } from '../../server/src/modules/routes/draftStore.ts';
import { RoutesPublicationCoordinator } from '../../server/src/modules/routes/publicationCoordinator.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { makeDraft } from '../../tests/fixtures/routes-editor.mjs';

const profile = 'sample';
const root = process.argv[2] ?? await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-native-routes-'));
const routesDir = path.join(root, 'routes');
const store = new RoutesStore({ baseDir: routesDir, lockTimeoutMs: 250 });

if (process.argv[2]) {
  await store.withProfileMutation(profile, async () => {
    console.log('ready');
    process.stdin.resume();
    await once(process.stdin, 'end');
  });
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), root], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');

  try {
    const [output] = await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => { throw new Error('The first editor exited before acquiring the lock'); }),
    ]);
    assert.equal(output.toString().trim(), 'ready');
    await assert.rejects(store.withProfileMutation(profile, () => {
      throw new Error('Entrant acquired the occupied lock');
    }), { code: 'ROUTES_V2_LOCKED' });
    child.kill();
    await exited;

    const profilesDir = path.join(root, 'profiles');
    const profileDir = path.join(profilesDir, profile);
    await fs.mkdir(path.join(profileDir, 'routes'), { recursive: true });
    await fs.writeFile(path.join(profileDir, 'graph.json'), '{}');
    await fs.writeFile(path.join(profileDir, 'routes', 'editor-capabilities.json'), JSON.stringify({
      schema: 1, commands: [{ id: 'project-check', label: 'Check', filesystem: ['state-only'] }],
      contextSections: [],
    }));

    const drafts = new DraftStore({ baseDir: path.join(root, 'authoring'), routesStore: store });
    await store.switchEditorSource(profile, { mode: 'editor', expectedSourceRevision: 0, expectedCatalogHash: null });
    const fixture = makeDraft();
    const draft = await drafts.create(profile, {
      title: 'Native Windows publication', baseCatalogHash: null, baseSourceRevision: 1,
      document: {
        routes: fixture.routes, bootstrap: fixture.bootstrap, bootstrapPrompts: fixture.bootstrapPrompts,
        presentation: fixture.presentation, provenance: fixture.provenance,
      },
    });
    const input = {
      draftId: draft.id, expectedRevision: draft.revision, expectedCatalogHash: null,
      expectedSourceRevision: 1, operationId: '44444444-4444-4444-8444-444444444444',
    };
    const editor = new RoutesPublicationCoordinator(store, drafts, profilesDir);
    const receipt = await editor.publish(profile, input);

    assert.deepEqual(await editor.publish(profile, input), receipt);
    assert.equal((await store.readCurrent(profile)).catalogHash, receipt.toCatalogHash);
    console.log('Cross-process route lock, crash release, editor publication and receipt replay passed.');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await exited.catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}
