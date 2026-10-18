import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TelegramCredentialsStore,
} from '../../server/src/lib/telegram/credentialsStore.ts';

const token = '8123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi';

async function fixture(now = () => 1_800_000_000_000) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-telegram-account-creds-'));
  const file = path.join(dir, 'telegram-account-creds.json');
  return {
    dir,
    file,
    store: new TelegramCredentialsStore({ file, now }),
  };
}

test('account-aware Telegram credentials связывает token с botId/accountRef и не публикует секрет', async () => {
  const { dir, file, store } = await fixture();
  try {
    const saved = await store.write({
      accountRef: 'acc_current_bot',
      botId: '8123456789',
      token,
      connectedAtMs: 1_799_000_000_000,
    });
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.channel, 'telegram');
    assert.equal(saved.botId, '8123456789');
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await store.publicView(), {
      configured: true,
      botId: '8123456789',
      tokenHint: '…fghi',
      connectedAtMs: 1_799_000_000_000,
    });
    assert.equal(JSON.stringify(await store.publicView()).includes(token), false);
    assert.equal((await store.read()).token, token);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('credentials отвергает token другого bot и неактуальную schema', async () => {
  const { dir, file, store } = await fixture();
  try {
    await assert.rejects(store.write({
      accountRef: 'acc_current_bot',
      botId: '9123456789',
      token,
      connectedAtMs: 1_799_000_000_000,
    }), (error) => error.code === 'telegram_credentials_owner_mismatch');

    await writeFile(file, `${JSON.stringify({ token, botId: 8123456789 })}\n`, { mode: 0o600 });
    await assert.rejects(store.read(), (error) => error.code === 'telegram_credentials_invalid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('credentials fail-closed на symlink и слишком широких правах', async () => {
  const { dir, file, store } = await fixture();
  try {
    const target = path.join(dir, 'target.json');
    await writeFile(target, '{}\n', { mode: 0o600 });
    await symlink(target, file);
    await assert.rejects(store.read(), (error) => error.code === 'telegram_credentials_unsafe');
    await rm(file);

    await store.write({
      accountRef: 'acc_current_bot',
      botId: '8123456789',
      token,
      connectedAtMs: 1_799_000_000_000,
    });
    await chmod(file, 0o644);
    await assert.rejects(store.read(), (error) => error.code === 'telegram_credentials_unsafe');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clear идемпотентен и не удаляет symlink target', async () => {
  const { dir, file, store } = await fixture();
  try {
    assert.equal(await store.clear(), false);
    const target = path.join(dir, 'target.json');
    await writeFile(target, 'keep\n', { mode: 0o600 });
    await symlink(target, file);
    await assert.rejects(store.clear(), (error) => error.code === 'telegram_credentials_unsafe');
    assert.equal(await readFile(target, 'utf8'), 'keep\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
