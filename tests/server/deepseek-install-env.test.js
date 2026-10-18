import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  DEEPSEEK_CHAT_MODES,
  DEEPSEEK_DIALECT,
  DEEPSEEK_PIN,
  DEEPSEEK_SANDBOX_MODES,
} from '../../server/src/lib/deepseek/contract.ts';
import {
  buildDeepSeekChildEnv,
  chatHomeFor,
  ensurePrivateDir,
  probeDeepSeekBin,
  runHomeFor,
} from '../../server/src/lib/deepseek/env.ts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'server/scripts/deepseekHarnessInstall.mts');

async function tempRoot(t, prefix = 'grigdesk-deepseek-p1-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('DeepSeek contract фиксирует pin, диалект и режимы', () => {
  assert.deepEqual(DEEPSEEK_PIN, {
    version: '0.1.5-rc.2',
    integrity: 'sha512-8Xc8hCQHcIWRmTCVU/xZdp6/qMsWMeAd2ObChKDEsfhUPJFXx6H0lgeb1DxUMD86HZrrVN+1bCvn1ppjZ/fOxw==',
  });
  assert.equal(DEEPSEEK_DIALECT, 'deepseek-harness-jsonl-v1');
  assert.deepEqual([...DEEPSEEK_SANDBOX_MODES], ['read-only', 'workspace-write', 'danger-full-access']);
  assert.deepEqual([...DEEPSEEK_CHAT_MODES], ['default', 'auto', 'read-only']);
});

test('дочернее окружение DSH — allowlist без чужих credentials и proxy', () => {
  const source = {
    PATH: '/bin', HOME: '/home/test', LANG: 'ru_RU.UTF-8', LC_ALL: 'C.UTF-8',
    TZ: 'Asia/Novosibirsk', TMPDIR: '/tmp/test', DEEPSEEK_API_KEY: 'deepseek-test-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret', OPENAI_API_KEY: 'openai-secret',
    KIMI_API_KEY: 'kimi-secret', GRIGDESK_PRIVATE: 'grigdesk-secret', HTTPS_PROXY: 'http://proxy',
    NODE_OPTIONS: '--inspect', FACTORY_RUN_ID: 'run-secret', MCP_TOOL_TIMEOUT: '99',
  };
  const env = buildDeepSeekChildEnv({ source, dshHome: '/private/dsh-home' });

  assert.deepEqual(env, {
    PATH: '/bin', HOME: '/home/test', LANG: 'ru_RU.UTF-8', LC_ALL: 'C.UTF-8',
    TZ: 'Asia/Novosibirsk', TMPDIR: '/tmp/test', DSH_HOME: '/private/dsh-home',
    DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'deepseek-test-secret', NO_COLOR: '1',
  });
  assert.throws(
    () => buildDeepSeekChildEnv({ source: { DEEPSEEK_API_KEY: '' }, dshHome: '/private' }),
    (error) => error?.code === 'deepseek_api_key_missing'
      && !String(error.message).includes('deepseek-test-secret'),
  );
});

test('per-chat/per-run home детерминированы, private dir имеет 0700', async (t) => {
  const root = await tempRoot(t);
  const expected = createHash('sha256').update('chat-one').digest('hex');
  assert.equal(chatHomeFor(root, 'chat-one'), path.join(root, 'chat', expected, 'home'));
  assert.notEqual(chatHomeFor(root, 'chat-one'), chatHomeFor(root, 'chat-two'));
  assert.equal(runHomeFor('/run/one'), '/run/one/deepseek/home');

  const privateDir = path.join(root, 'private', 'nested');
  await ensurePrivateDir(privateDir);
  assert.equal((await fs.stat(privateDir)).mode & 0o777, 0o700);
});

test('probe допускает только pinned dsh', async (t) => {
  const root = await tempRoot(t);
  const good = path.join(root, 'good-dsh');
  const old = path.join(root, 'old-dsh');
  await fs.writeFile(good, '#!/bin/sh\nprintf "0.1.5-rc.2\\n"\n', { mode: 0o755 });
  await fs.writeFile(old, '#!/bin/sh\nprintf "0.1.4\\n"\n', { mode: 0o755 });

  assert.deepEqual(await probeDeepSeekBin(good), { ok: true, version: '0.1.5-rc.2' });
  assert.deepEqual(await probeDeepSeekBin(old), {
    ok: false,
    version: '0.1.4',
    error: 'Версия DeepSeek не соответствует descriptor',
  });
  const missing = await probeDeepSeekBin(path.join(root, 'missing'));
  assert.equal(missing.ok, false);
  assert.equal(missing.version, null);
});

test('install проверяет version/integrity, атомарно переключает current и идемпотентен', async (t) => {
  const root = await tempRoot(t, 'grigdesk-deepseek-install-');
  const binDir = path.join(root, 'bin');
  const runtimeHome = path.join(root, 'runtime');
  const log = path.join(root, 'npm-log.ndjson');
  const npm = path.join(binDir, 'npm');
  await fs.mkdir(binDir);
  await fs.writeFile(npm, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
const packageDir = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh');
fs.mkdirSync(packageDir, { recursive: true });
const version = process.env.FAKE_NPM_VERSION || ${JSON.stringify(DEEPSEEK_PIN.version)};
const integrity = process.env.FAKE_NPM_INTEGRITY || ${JSON.stringify(DEEPSEEK_PIN.integrity)};
fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version }));
fs.writeFileSync(path.join(prefix, 'package-lock.json'), JSON.stringify({
  packages: { 'node_modules/@deepseek-ai/dsh': { version, integrity } },
}));
`, { mode: 0o755 });

  const run = (extraEnv = {}) => execFileAsync(process.execPath, [
    INSTALL_SCRIPT,
    '--runtime-home', runtimeHome,
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      FAKE_NPM_LOG: log,
      ...extraEnv,
    },
  });

  await assert.rejects(run({ FAKE_NPM_INTEGRITY: 'sha512-wrong' }), /integrity/);
  await assert.rejects(fs.lstat(path.join(runtimeHome, 'install', 'current')));
  assert.deepEqual(
    (await fs.readdir(path.join(runtimeHome, 'install'))).filter((name) => name.startsWith('staging-')),
    [],
  );

  await run();
  assert.equal(
    await fs.readlink(path.join(runtimeHome, 'install', 'current')),
    DEEPSEEK_PIN.version,
  );
  await run();

  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2, 'неудачная и одна успешная установка; повтор не вызывает npm');
  for (const argv of calls) {
    const joined = argv.join(' ');
    assert.match(joined, /@deepseek-ai\/dsh@0\.1\.5-rc\.2/);
    assert.doesNotMatch(joined, /\bnpx\b|latest|[\^~]0\.1\.5/);
  }
});
