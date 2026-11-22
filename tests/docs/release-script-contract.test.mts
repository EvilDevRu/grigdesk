import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { fixtureGo } from '../helpers/goBuildFixture.mts';

const root = path.resolve(import.meta.dirname, '../..');
const execute = promisify(execFile);

test('INSTALL-GUIDE: обе редакции используют shell и разделяют два источника доверия', async () => {
  const help = await execute(fixtureGo('grigdesk-ctl'), ['dist', '--help'], {
    cwd: root,
    env: {
      ...process.env,
      GRIGDESK_CTL_CHECKOUT_ROOT: root,
    },
  });

  for (const language of ['ru', 'en']) {
    const guide = await fs.readFile(path.join(root,
      `docs/grigdesk/guide/${language}/installation.md`), 'utf8');

    assert.match(guide, /sh \.\/grigdesk-install/u);
    assert.match(guide, /grigdesk-X\.Y\.Z-linux-x64-offline\.zip/u);
    assert.match(guide, /sh \.\/grigdesk-install --source-dir "\$PWD"/u);
    assert.match(guide, /sudo apt install \.\/grigdesk_X\.Y\.Z_amd64\.deb/u);
    assert.doesNotMatch(guide, /grigdesk-install --verify/u);
    assert.match(guide, /dist check --from/u);
    assert.match(guide, /dist check --local-run/u);
    assert.match(help.stdout, /dist check --from/u);
    assert.match(help.stdout, /dist check --local-run/u);

    for (const mode of ['local', 'remote', 'server']) {
      assert.ok(guide.includes(mode));
    }
  }
});
