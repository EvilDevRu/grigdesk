import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import claude from '../../server/src/lib/executors/claude.ts';
import { createAttempt, profileFixture, profiles, settled, submit, vendorServer } from './accessProfiles.js';
import { CLI_VERSIONS, cliStep, prepareCliFixture } from './accessCliFixture.js';

/**
 * Legacy OAuth подготовлен до boot: миграция читает тот же CLAUDE_CONFIG_DIR.
 * Рабочий refresh token и metadata синтетические, сервер не открывает home владельца.
 */
export async function oauthFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'access-oauth-'));
  const vendor = await vendorServer(t);
  const { home, executable } = await prepareCliFixture(root, 'claude');
  let f;

  t.after(async () => {
    await f?.app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(home, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'synthetic-expired-access',
      refreshToken: 'synthetic-working-refresh',
      expiresAt: 1,
      clientId: 'fixture-client-id',
      tokenUrl: `${vendor.origin}/v1/oauth/token`,
      scopes: ['user:profile', 'user:inference'],
    },
  }), { mode: 0o600 });
  await fs.writeFile(path.join(root, '.env'), `CLAUDE_CONFIG_DIR=${home}\n`, { mode: 0o600 });
  vendor.control.answer = (call) => call.path === '/v1/oauth/token'
    ? {
      access_token: 'synthetic-fresh-access',
      refresh_token: 'synthetic-rotated-refresh',
      expires_in: 3600,
    }
    : { limits: [{
      kind: 'session',
      percent: call.authorization === 'Bearer synthetic-cli-secret-token' ? 12 : 91,
    }] };
  f = await profileFixture(t, {
    root,
    vendor,
    env: { HOME: root, CLAUDE_CONFIG_DIR: home },
    config: { claudeBin: executable },
    adapters: [{
      ...claude,
      externalCli: undefined,
      latestVersion: undefined,
      commands: undefined,
      catalog: undefined,
      nativeSettings: undefined,
      probe: async () => ({ ok: true, version: CLI_VERSIONS.claude }),
      bin: () => executable,
    }],
  });

  return f;
}

/**
 * Новая ревизия сохраняется настоящим reauth, пока старый HTTP exchange ещё удержан.
 * Приватный manifest тест не переписывает: CAS и выдача revision принадлежат продукту.
 */
export async function replaceOauth(f, profile = null) {
  const list = await profiles(f, 'claude');
  const method = list.methods.find((item) => item.kind === 'cli');

  assert.ok(method, 'повторный вход объявлен адаптером');

  const attempt = await createAttempt(f, 'claude', method, profile ? { profileId: profile.id } : {});
  const waiting = await cliStep({ ...f, provider: 'claude' }, attempt, 'enter-code');

  await submit(f, 'claude', waiting, { code: 'SITE-CLI-5678#fixture-state' });

  let result = await settled(f, 'claude', attempt);

  if (result.step?.kind === 'choice') {
    await submit(f, 'claude', result, { choice: 'confirm' });
    result = await settled(f, 'claude', attempt, ['result']);
  }

  assert.equal(result.state, 'saved');
  await f.app.accessProfiles.drivers.get(attempt.id)?.finished;

  const after = await profiles(f, 'claude');
  const saved = after.profiles.find((item) => profile ? item.id === profile.id
    : !list.profiles.some((old) => old.id === item.id));

  assert.ok(saved, 'CLI-вход сохранил нужный профиль');

  return saved;
}
