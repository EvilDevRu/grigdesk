import assert from 'node:assert/strict';
import {
  spawn
} from 'node:child_process';
import {
  promises as fs
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildGigaCodeProfile
} from '../../server/src/lib/gigacode/profile.ts';
import {
  makeGigaCodeFixture
} from '../helpers/gigacode/fixture.mjs';

test('перед новым home удаляются только turn-каталоги с доказанно мёртвым владельцем', async (t) => {
  const fixture = await makeGigaCodeFixture(t);
  const root = fixture.config.gigacodeRuntimeHome;
  const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
  const starttime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19];
  const live = {
    pid: process.pid,
    starttime,
  };
  const owners = {
    'turn-dead': {
      pid: 2147483647,
      starttime: '1',
    },
    'turn-reused': {
      pid: process.pid,
      starttime: `${starttime}1`,
    },
    'turn-live': live,
    'turn-invalid': {
      pid: 'invalid',
      starttime,
    },
    'turn-creating': null,
    'unrelated-dead': {
      pid: 2147483647,
      starttime: '1',
    },
  };

  await assert.rejects(fs.access('/proc/2147483647/stat'));
  await fs.mkdir(root, {
    recursive: true,
    mode: 0o700,
  });

  for (const [name, owner] of Object.entries(owners)) {
    const directory = path.join(root, name);

    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(directory, 'credential-canary'), 'synthetic-orphan-token');

    if (owner) {
      await fs.writeFile(path.join(directory, 'owner'), JSON.stringify(owner), { mode: 0o600 });
    }
  }

  await fs.symlink(fixture.workspace, path.join(root, 'turn-symlink'));

  const profile = await buildGigaCodeProfile({
    config: fixture.config,
    cwd: fixture.workspace,
  });

  t.after(() => profile.cleanup());
  await assert.rejects(fs.access(path.join(root, 'turn-dead')));
  await assert.rejects(fs.access(path.join(root, 'turn-reused')));

  for (const name of ['turn-live', 'turn-invalid', 'turn-creating', 'unrelated-dead']) {
    assert.equal(await fs.readFile(path.join(root, name, 'credential-canary'), 'utf8'),
      'synthetic-orphan-token');
  }

  assert.equal((await fs.lstat(path.join(root, 'turn-symlink'))).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile.home, 'owner'), 'utf8')), live);
  assert.equal((await fs.stat(path.join(profile.home, 'owner'))).mode & 0o777, 0o600);

  const readonly = await probe(profile, `
    const fs = require('node:fs');
    let outcome = 'written';
    try {
      fs.writeFileSync(${JSON.stringify(path.join(profile.home, 'owner'))}, '{}');
    } catch (error) {
      outcome = error.code;
    }
    console.log(JSON.stringify(outcome));
  `);

  assert.equal(readonly, 'EROFS');
});

/**
 * Проверяется настоящий kernel mount namespace, а не только список argv.
 * Небольшой Node probe пытается читать и писать через те же mounts, что и CLI.
 */
async function probe(profile, script) {
  const args = [...profile.prefixArgs, '--', process.execPath, '-e', script];
  const child = spawn(profile.command, args, {
    env: {},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  assert.equal(code, 0, stderr);

  return JSON.parse(stdout);
}

test('state-only: исходник и symlink защищены, отчёт writable, чужой home скрыт', async (t) => {
  const fixture = await makeGigaCodeFixture(t);
  const reports = path.join(fixture.workspace, 'отчёты с пробелами');
  const source = path.join(fixture.workspace, 'canary.txt');
  const secret = path.join(fixture.root, 'outside.txt');
  const linked = path.join(reports, 'escape');

  await fs.mkdir(reports);
  await fs.writeFile(source, 'unchanged');
  await fs.writeFile(secret, 'hidden');
  await fs.symlink(source, linked);

  const profile = await buildGigaCodeProfile({
    config: fixture.config,
    cwd: fixture.workspace,
    permissionMode: 'state-only',
    writableRoots: [reports],
  });

  t.after(() => profile.cleanup());

  assert.ok(profile.args.includes('--include-directories'));
  assert.ok(profile.args.includes(reports));

  const probeFiles = {
    source,
    linked,
    report: path.join(reports, 'ok'),
  };
  const result = await probe(profile, `
    const fs = require('node:fs');
    const out = {};
    for (const [key, file] of Object.entries(${JSON.stringify(probeFiles)})) {
      try { fs.writeFileSync(file, 'written'); out[key] = 'written'; }
      catch (error) { out[key] = error.code; }
    }
    out.secretVisible = fs.existsSync(${JSON.stringify(secret)});
    out.nativeHomeVisible = fs.existsSync(${JSON.stringify(fixture.config.gigacodeHome)});
    console.log(JSON.stringify(out));
  `);

  assert.equal(result.source, 'EROFS');
  assert.notEqual(result.linked, 'written');
  assert.equal(result.report, 'written');
  assert.equal(result.secretVisible, false);
  assert.equal(result.nativeHomeVisible, false);
  assert.equal(await fs.readFile(source, 'utf8'), 'unchanged');
  assert.equal(await fs.readFile(secret, 'utf8'), 'hidden');
});

test('профиль маскирует settings/env, extraDirs readonly и сохраняет исходные файлы', async (t) => {
  const fixture = await makeGigaCodeFixture(t);
  const extra = path.join(fixture.root, 'extra');
  const native = path.join(fixture.workspace, '.gigacode');
  const settings = '{"hooks":{"malicious":true},"mcpServers":{"override":{}}}';

  await fs.mkdir(extra);
  await fs.mkdir(native);
  await fs.writeFile(path.join(native, 'settings.json'), settings);
  await fs.writeFile(path.join(fixture.workspace, '.env'), 'OTHER_SECRET=private');

  const profile = await buildGigaCodeProfile({
    config: fixture.config,
    cwd: fixture.workspace,
    permissionMode: 'default',
    extraDirs: [extra],
  });

  t.after(() => profile.cleanup());

  const result = await probe(profile, `
    const fs = require('node:fs');
    const out = { settings: fs.existsSync(${JSON.stringify(native + '/settings.json')}),
      env: fs.readFileSync(${JSON.stringify(fixture.workspace + '/.env')}, 'utf8') };
    try { fs.writeFileSync(${JSON.stringify(extra + '/denied')}, 'x'); out.extra = 'written'; }
    catch (error) { out.extra = error.code; }
    fs.writeFileSync(${JSON.stringify(fixture.workspace + '/allowed')}, 'ok');
    console.log(JSON.stringify(out));
  `);

  assert.equal(result.settings, false);
  assert.equal(result.env, '');
  assert.equal(result.extra, 'EROFS');
  assert.equal(await fs.readFile(path.join(native, 'settings.json'), 'utf8'), settings);
  assert.equal(await fs.readFile(path.join(fixture.workspace, '.env'), 'utf8'),
    'OTHER_SECRET=private');
});

test('в комплекте сервера профиль не строится и не копирует вход', async (t) => {
  const fixture = await makeGigaCodeFixture(t);

  await assert.rejects(buildGigaCodeProfile({
    config: {
      ...fixture.config,
      gigacodePackaged: true
    },
    cwd: fixture.workspace
  }), (error) => error.code === 'gigacode_packaged_unsupported' && /комплекте сервера/u.test(error.message));

  const entries = await fs.readdir(fixture.config.gigacodeRuntimeHome).catch(() => []);

  assert.deepEqual(entries.filter((name) => name.startsWith('turn-')), []);
});

test('неизвестный режим, broad roots и writable code в state-only отклоняются до spawn', async (t) => {
  const fixture = await makeGigaCodeFixture(t);
  const base = {
    config: fixture.config,
    cwd: fixture.workspace
  };

  await assert.rejects(buildGigaCodeProfile({
    ...base,
    permissionMode: 'surprise'
  }), /режим/u);
  await assert.rejects(buildGigaCodeProfile({
    ...base,
    extraDirs: [fixture.root]
  }), /пересека/u);

  const nestedPrivate = path.join(fixture.config.gigacodeRuntimeHome, 'other-turn');

  await fs.mkdir(nestedPrivate, {
    recursive: true,
    mode: 0o700
  });
  await assert.rejects(buildGigaCodeProfile({
    ...base,
    extraDirs: [nestedPrivate]
  }), /пересека/u);
  await assert.rejects(buildGigaCodeProfile({
    ...base,
    writableRoots: [nestedPrivate]
  }), /пересека/u);
  await assert.rejects(buildGigaCodeProfile({
    ...base,
    permissionMode: 'state-only',
    writableRoots: [fixture.workspace],
  }), /state-only/u);
});

test('credential snapshot одного запуска неизменен после обновления входа следующего', async (t) => {
  const fixture = await makeGigaCodeFixture(t);
  const options = {
    config: fixture.config,
    cwd: fixture.workspace,
    permissionMode: 'read-only'
  };
  const first = await buildGigaCodeProfile(options);

  t.after(() => first.cleanup());
  await fs.writeFile(path.join(fixture.config.gigacodeHome, 'gigacode_token.json'), JSON
    .stringify({
      token: 'synthetic-next-account',
      expiryDate: Date.now() + 3600000,
    }), {
      mode: 0o600
    });

  const second = await buildGigaCodeProfile(options);

  t.after(() => second.cleanup());
  assert.notEqual(first.home, second.home);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.match(await fs.readFile(path.join(first.home, '.gigacode/gigacode_token.json'), 'utf8'),
    /synthetic-native-fixture-token/u);
  assert.match(await fs.readFile(path.join(second.home, '.gigacode/gigacode_token.json'), 'utf8'),
    /synthetic-next-account/u);
});
