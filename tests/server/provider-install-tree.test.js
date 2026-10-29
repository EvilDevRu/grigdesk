import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { treeSnapshot } from '../../server/src/lib/providerInstall/treeSnapshot.ts';

test('preview fingerprint видит порчу dependency, смену mode и symlink без обхода наружу', async (t) => {
  const root = await fs.mkdtemp('/tmp/grigdesk-cli-tree-');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'entry'), 'one');
  await fs.symlink('/nonexistent', path.join(root, 'alias'));

  const before = await treeSnapshot(root);

  await fs.writeFile(path.join(root, 'entry'), 'two');
  assert.notEqual(await treeSnapshot(root), before);
  await fs.writeFile(path.join(root, 'entry'), 'one');
  assert.equal(await treeSnapshot(root), before);
  await fs.chmod(path.join(root, 'entry'), 0o700);
  assert.notEqual(await treeSnapshot(root), before);
});
