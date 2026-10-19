import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { resolveDeepSeekRuntimeAsync } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { writeDeepSeekBinaryStub } from '../helpers/deepseekBinaryStub.mts';
import {
  DEEPSEEK_CHAT_MODES,
  DEEPSEEK_DIALECT,
  DEEPSEEK_PIN,
  DEEPSEEK_SANDBOX_MODES,
} from '../../server/src/lib/deepseek/contract.ts';
import {
  buildDeepSeekChildEnv,
  buildHarnessChildEnv,
  chatHomeFor,
  ensurePrivateDir,
  probeDeepSeekBin,
  runHomeFor,
} from '../../server/src/lib/deepseek/env.ts';

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

test('metadata-only окружение Harness не требует и не наследует ключ модели', () => {
  const env = buildHarnessChildEnv({
    source: {
      PATH: '/bin',
      DEEPSEEK_API_KEY: 'must-not-leak',
      ZAI_API_KEY: 'must-not-leak-zai',
      NODE_OPTIONS: '--inspect',
      HTTPS_PROXY: 'http://private-proxy',
    },
    dshHome: '/private/probe-home',
  });

  assert.deepEqual(env, {
    PATH: '/bin',
    DSH_HOME: '/private/probe-home',
    DSH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
  });
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

test('probe принимает совместимые metadata и отклоняет stock dsh при любом номере', async (t) => {
  const root = await tempRoot(t);
  const pinned = path.join(root, 'pinned-stock-dsh');
  const old = path.join(root, 'old-dsh');
  const info = runtimeInfoFixture();

  const { binary: good } = await writeDeepSeekBinaryStub(t,
    `process.stdout.write(${JSON.stringify(JSON.stringify(info))});`);

  await fs.writeFile(pinned, '#!/bin/sh\nprintf "0.1.5-rc.2\\n"\n', { mode: 0o755 });
  await fs.writeFile(old, '#!/bin/sh\nprintf "0.1.4\\n"\n', { mode: 0o755 });

  const compatible = await probeDeepSeekBin(good);

  assert.equal(compatible.ok, true);
  assert.equal(compatible.version, info.upstreamVersion);

  for (const stock of [pinned, old]) {
    const result = await probeDeepSeekBin(stock);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'deepseek_binary_metadata_invalid');
    assert.equal(result.version, null);
  }

  const missing = await probeDeepSeekBin(path.join(root, 'missing'));
  assert.equal(missing.ok, false);
  assert.equal(missing.version, null);
});

/**
 * Stock install снят решением владельца вместе с installed/external доставкой.
 * Старые флаги не позволяют обойти metadata и запустить рабочий профиль stock CLI.
 */
test('stock install удалён; legacy флаги не включают fallback или рабочий запуск dsh', async (t) => {
  await assert.rejects(fs.access(INSTALL_SCRIPT), { code: 'ENOENT' });
  assert.equal(deepseek.install, undefined);

  const marker = path.join(os.tmpdir(), `stock-prompt-${process.pid}-${Date.now()}`);
  const { binary } = await writeDeepSeekBinaryStub(t,
    'if (process.argv[2] === "--runtime-info") process.exit(64);\n'
    + `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected");\n`
    + `console.log(${JSON.stringify(DEEPSEEK_PIN.version)});`);

  t.after(() => fs.rm(marker, { force: true }));

  for (const mode of ['installed', 'external', 'embedded']) {
    await assert.rejects(resolveDeepSeekRuntimeAsync({
      deepseekBin: binary,
      deepseekRuntimeMode: mode,
      deepseekArtifactDir: path.join(path.dirname(binary), 'legacy'),
    }), { code: 'deepseek_binary_unsupported' });
  }

  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});
