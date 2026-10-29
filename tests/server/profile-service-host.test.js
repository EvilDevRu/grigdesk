import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readProfileServiceHost } from '../../server/src/lib/profileServiceHost.ts';

test('хост профиля читается без исполнения shell и без перехода в соседний каталог', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-service-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = path.join(root, 'profiles');
  const profile = path.join(profiles, 'sample');
  const marker = path.join(root, 'executed');

  await mkdir(profile, { recursive: true });

  for (const [assignment, expected] of [
    ['"localhost"', 'localhost'],
    ["'app.example.test' # локальный домен", 'app.example.test'],
    ['[::1]', '[::1]'],
    ['host:80', null],
    ['https://other.test', null],
    ['user@other.test', null],
    [`"$(touch ${marker})"`, null],
    ['$DYNAMIC_HOST', null],
  ]) {
    await writeFile(path.join(profile, 'profile.sh'), `PROFILE_SERVICE_HOST=${assignment}\n`);
    assert.equal(await readProfileServiceHost(profiles, 'sample'), expected);
  }

  await assert.rejects(access(marker));
  await writeFile(path.join(root, 'profile.sh'), 'PROFILE_SERVICE_HOST=outside.test\n');
  assert.equal(await readProfileServiceHost(profiles, '..'), null);
  assert.equal(await readProfileServiceHost(profiles, 'missing'), null);
});
