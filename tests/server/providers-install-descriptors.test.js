import assert from 'node:assert/strict';
import test from 'node:test';

import claude from '../../server/src/lib/executors/claude.ts';
import codex from '../../server/src/lib/executors/codex.ts';
import kimi from '../../server/src/lib/executors/kimi.ts';
import { getProviderAdapters } from '../../server/src/lib/executors/index.ts';

const config = {
  claudeBin: '/fixture/custom-claude',
  codexBin: '/fixture/custom-codex',
  kimiBin: '/fixture/custom-kimi',
  kimiLaunchMode: 'host',
};

const commands = new Map([
  [claude, 'curl -fsSL https://claude.ai/install.sh | bash'],
  [codex, 'npm i -g @openai/codex'],
  [kimi, 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'],
]);

test('внешний inventory и свежесть явно объявляют только три CLI, contained сохраняет запрет', async () => {
  const expected = new Map([
    [claude, '@anthropic-ai/claude-code'],
    [codex, '@openai/codex'],
    [kimi, '@moonshot-ai/kimi-code'],
  ]);

  for (const [adapter, packageId] of expected) {
    assert.equal(typeof adapter.externalCli, 'function');

    const declaration = adapter.externalCli(config, '/fixture/home');

    assert.equal(declaration.packageId, packageId);
    assert.equal(declaration.binName, adapter.id);
    assert.deepEqual(adapter.usagePresentation, { freshness: true, spentLabel: true });
  }

  assert.equal(kimi.externalCli({ ...config, kimiLaunchMode: 'contained' }, '/fixture/home'), null);

  for (const id of ['deepseek', 'glm', 'tripo']) {
    const adapter = (await getProviderAdapters()).get(id);

    assert.equal(adapter.externalCli, undefined);
    assert.equal(adapter.usagePresentation, undefined);
  }
});

test('три адаптера разделяют installer, login и fallback', async (t) => {
  for (const [adapter, command] of commands) {
    await t.test(adapter.id, () => {
      assert.equal(typeof adapter.installation, 'function', 'Нет декларации серверной установки');

      const declaration = adapter.installation(config);

      assert.equal(declaration.install.command, command);
      assert.equal(declaration.loginCommand, `${adapter.id} login`);
      assert.equal(declaration.install.fallbackCommand, adapter.install);
      assert.equal(declaration.install.args.some((arg) => /\blogin\b/u.test(arg)), false);

      if (adapter !== codex) {
        assert.match(declaration.install.executable, /(?:^|\/)bash$/u);
        assert.ok(declaration.install.args.includes('pipefail'));
      }
      if (adapter !== kimi) {
        assert.equal(declaration.update.executable, adapter.bin(config));
        assert.deepEqual(declaration.update.args, adapter.updateCmd);
      }
    });
  }
});

test('Kimi update разрешён только host', () => {
  assert.equal(typeof kimi.installation, 'function', 'Нет capability установки Kimi');

  const host = kimi.installation(config);
  const contained = kimi.installation({
    ...config,
    kimiLaunchMode: 'contained'
  });

  assert.equal(host.update.command, commands.get(kimi));
  assert.equal(host.update.fallbackCommand, commands.get(kimi));
  assert.equal(contained.update, null);
  assert.equal(contained.install.command, kimi.install);
});

test('Kimi latest читает официальный пакет', async (t) => {
  const requests = [];

  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));

    return {
      ok: true,
      json: async () => ({ version: '7.8.9' })
    };
  });
  assert.equal(typeof kimi.latestVersion, 'function', 'Нет источника latest Kimi');
  assert.equal(await kimi.latestVersion(config), '7.8.9');
  assert.deepEqual(requests, ['https://registry.npmjs.org/@moonshot-ai/kimi-code/latest']);
  assert.equal(await kimi.latestVersion({
    ...config,
    kimiLaunchMode: 'contained'
  }), null);
  assert.equal(requests.length, 1, 'Contained не опрашивает источник host-версии');
});
