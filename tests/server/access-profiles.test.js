import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  OLD_KEY, activate, active, addProfile, apiAdapters, base, operationId,
  profileFixture, profiles, resolvedAdapter, syntheticAdapter, vendorServer,
} from '../helpers/accessProfiles.js';
import { cliFixture } from '../helpers/accessCliFixture.js';

test('AP01_saved_profiles: имя, UUID, несколько сохранённых и только один активный', async (t) => {
  const f = await profileFixture(t);
  const before = await profiles(f);
  const original = active(before);
  const second = await addProfile(f);

  assert.notEqual(second.id, original.id);
  assert.equal((await profiles(f)).activeProfileId, original.id);

  const renamed = await f.request('PATCH', `${base()}/${second.id}`, {
    operationId: operationId(),
    expectedRevision: second.revision,
    name: 'Рабочий аккаунт',
  });

  assert.equal(renamed.profile.id, second.id);
  assert.equal(renamed.profile.name, 'Рабочий аккаунт');
  await activate(f, renamed.profile);
  await f.restart();

  const after = await profiles(f);

  assert.equal(after.activeProfileId, second.id);
  assert.deepEqual(after.profiles.map((item) => item.id).sort(), [original.id, second.id].sort());
  assert.equal(after.profiles.find((item) => item.id === second.id).name, 'Рабочий аккаунт');
  assert.equal(JSON.stringify(after).includes(OLD_KEY), false);
  assert.equal(JSON.stringify(after).includes('secretRef'), false);
});

test('AP02_migrate_once: env не теряется, два ключа GLM мигрируют один раз', async (t) => {
  const vendor = await vendorServer(t);
  const env = {
    DEEPSEEK_API_KEY: OLD_KEY,
    ZAI_API_KEY: 'synthetic-migration-api-key',
    ZAI_CODING_API_KEY: 'synthetic-migration-coding-key',
    GRIGDESK_GLM_API_MODE: 'coding-plan',
  };
  const f = await profileFixture(t, {
    env,
    vendor,
    adapters: apiAdapters(env, vendor)
  });
  const originalEnv = await fs.readFile(f.config.envPath, 'utf8');
  const deepseek = await profiles(f, 'deepseek');
  const glm = await profiles(f, 'glm');

  assert.equal(deepseek.profiles.length, 1);
  assert.equal(glm.profiles.length, 2);
  assert.deepEqual(glm.profiles.map((item) => item.mode).sort(), ['api', 'coding-plan']);
  assert.equal(active(glm).mode, env.GRIGDESK_GLM_API_MODE);

  for (let restart = 0; restart < 2; restart += 1) {
    await f.restart();
    assert.deepEqual(await profiles(f, 'deepseek'), deepseek);
    assert.deepEqual(await profiles(f, 'glm'), glm);
    assert.equal(await fs.readFile(f.config.envPath, 'utf8'), originalEnv);
  }
});

test('AP02_migrate_once: прежний CLI-home сохраняет доступ и UUID после двух рестартов', async (t) => {
  for (const provider of ['codex', 'claude', 'kimi']) {
    await t.test(provider, async (t) => {
      const f = await cliFixture(t, provider);
      const before = await profiles(f, provider);
      const calls = [];
      const homeKey = {
        codex: 'CODEX_HOME',
        claude: 'CLAUDE_CONFIG_DIR',
        kimi: 'KIMI_CODE_HOME',
      };

      f.adapters.get(provider).run = syntheticAdapter(calls).run;
      assert.equal(before.profiles.length, 1);
      assert.equal(active(before).authState, 'ready');
      assert.equal(f.env[homeKey[provider]], f.home);

      for (let restart = 0; restart < 2; restart += 1) {
        await f.restart();
        assert.deepEqual(await profiles(f, provider), before);

        const executor = await resolvedAdapter(f, provider);

        await executor.run({
          config: f.config,
          model: 'fixture-model',
          message: 'Старый CLI-доступ',
        });

        const selectedHome = calls.at(-1).env[homeKey[provider]];
        const credentialRelative = path.relative(f.home, f.credentialFile);

        assert.ok(selectedHome, 'child получил home выбранного доступа');
        assert.equal(await fs.readFile(path.join(selectedHome, credentialRelative), 'utf8'),
          f.credentialBytes);
        assert.equal(await fs.readFile(f.credentialFile, 'utf8'), f.credentialBytes);
        assert.equal(JSON.stringify(await profiles(f, provider)).includes(f.home), false);
      }
    });
  }
});
