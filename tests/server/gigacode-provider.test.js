import assert from 'node:assert/strict';
import {
  promises as fs
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  setTimeout as delay
} from 'node:timers/promises';

import {
  getProviderAdapters,
  isChatExecutor
} from '../../server/src/lib/executors/index.ts';
import providersModule from '../../server/src/modules/providers/index.ts';

const Fastify = createRequire(new URL('../../server/package.json', import.meta.url))('fastify');

/**
 * Установка синтетическая: пакет повторяет подтверждённую идентичность поставки,
 * а исполняемый файл умеет только metadata и отказывает на любой prompt.
 */
async function installation(t, version = '26.7.33') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gigacode-provider-'));
  const bin = path.join(root, 'gigacode');

  t.after(() => fs.rm(root, {
    recursive: true,
    force: true
  }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: '@gigacode/gigacode',
    version: '0.13.1',
    type: 'module',
  }));
  await fs.writeFile(bin, [
    `#!${process.execPath}`,
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(path.join(root, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));`,
    "if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(97);",
    `console.log(${JSON.stringify(JSON.stringify(version))});`,
  ].join('\n'), {
    mode: 0o755
  });

  return {
    root,
    bin
  };
}

test('GigaCode обнаруживается обычным реестром, без допуска недоказанного runtime', async () => {
  const adapter = (await getProviderAdapters()).get('gigacode');

  assert.ok(adapter, 'нет адаптера gigacode');
  assert.equal(adapter.name, 'GigaCode');
  assert.equal(adapter.type, 'universal');
  assert.equal(adapter.kind, 'cli');
  assert.equal(isChatExecutor(adapter), true);
  assert.deepEqual(adapter.seedModels(), []);
});

test('probe проверяет подтверждённый пакет и версию без prompt и ключа', async (t) => {
  const {
    probeGigaCode
  } = await import('../../server/src/lib/gigacode/discovery.ts');
  const fixture = await installation(t);
  const result = await probeGigaCode({
    gigacodeBin: fixture.bin
  });

  assert.equal(result.ok, true);
  assert.equal(result.version, '26.7.33');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(fixture.root, 'argv.json'), 'utf8')), [
    '--version',
  ]);
});

test('в комплекте сервера probe отказывает с причиной и не запускает CLI', async (t) => {
  const {
    probeGigaCode
  } = await import('../../server/src/lib/gigacode/discovery.ts');
  const fixture = await installation(t);
  const result = await probeGigaCode({
    gigacodeBin: fixture.bin,
    gigacodePackaged: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.version, null);
  assert.equal(result.code, 'gigacode_packaged_unsupported');
  assert.match(result.warning, /комплекте сервера/u);
  await assert.rejects(fs.access(path.join(fixture.root, 'argv.json')), /ENOENT/u);
});

test('нет установки и чужой пакет отклоняются, неизвестная версия остаётся доступной', async (t) => {
  const {
    probeGigaCode
  } = await import('../../server/src/lib/gigacode/discovery.ts');
  const fixture = await installation(t, '99.1.0');

  assert.equal((await probeGigaCode({
      gigacodeBin: `${fixture.root}/absent`
    })).code,
    'gigacode_not_installed');
  assert.equal((await probeGigaCode({ gigacodeBin: fixture.bin })).ok, true);

  await fs.writeFile(path.join(fixture.root, 'package.json'), JSON.stringify({
    name: '@synthetic/other-product',
    version: '0.13.1',
  }));
  await fs.rm(path.join(fixture.root, 'argv.json'));

  assert.equal((await probeGigaCode({
      gigacodeBin: fixture.bin
    })).code,
    'gigacode_identity_unverified');
  await assert.rejects(fs.access(path.join(fixture.root, 'argv.json')));
});

test('обновление 26.8.0 сохраняет доступность, карточка предупреждает о проверенной версии', async (t) => {
  const fixture = await installation(t, '26.8.0');
  const adapter = (await getProviderAdapters()).get('gigacode');
  const app = Fastify({ logger: false });
  const config = {
    gigacodeBin: fixture.bin,
    gigacodeHome: fixture.root,
    modelsPath: path.join(fixture.root, 'models.json'),
    providerUsageSeenPath: path.join(fixture.root, 'usage-seen.json'),
  };

  t.after(() => app.close());
  await fs.writeFile(path.join(fixture.root, 'gigacode_token.json'), JSON.stringify({
    token: 'synthetic-updated-token',
    expiryDate: Date.now() + 3600000,
  }), { mode: 0o600 });
  await app.register(providersModule, {
    config,
    getProviderAdapters: async () => new Map([['gigacode', adapter]]),
    getModelsRegistry: async () => ({ gigacode: [] }),
  });

  const response = await app.inject('/api/providers');

  assert.equal(response.statusCode, 200);

  const card = response.json().providers.find((entry) => entry.id === 'gigacode');

  assert.equal(card.installed, true);
  assert.equal(card.available, true);
  assert.equal(card.version, '26.8.0');
  assert.match(card.authLabel, /[Вв]ерсия 26\.8\.0 не проверена, проверена 26\.7\.33/u);
});

test('каталог вместо CLI отклоняется до запуска', async (t) => {
  const {
    probeGigaCode
  } = await import('../../server/src/lib/gigacode/discovery.ts');
  const fixture = await installation(t);
  const directory = path.join(fixture.root, 'directory');

  await fs.mkdir(directory);

  assert.equal((await probeGigaCode({
    gigacodeBin: directory
  })).code, 'gigacode_not_installed');
});

test('зависший metadata процесс ограничен сроком и остановлен без ключа', async (t) => {
  const {
    probeGigaCode
  } = await import('../../server/src/lib/gigacode/discovery.ts');
  const fixture = await installation(t);
  const pidFile = path.join(fixture.root, 'pid');

  await fs.writeFile(fixture.bin, [
    `#!${process.execPath}`,
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'), {
    mode: 0o755
  });

  const result = await probeGigaCode({
    gigacodeBin: fixture.bin
  }, {
    timeoutMs: 1000
  });
  const pid = Number(await fs.readFile(pidFile, 'utf8'));

  assert.equal(result.code, 'gigacode_probe_timeout');

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }

    await delay(25);
  }

  assert.fail('собственный metadata процесс остался жить');
});

test('доступ использует native OAuth cache, не требует API key и не выдаёт токен', async (t) => {
  const fixture = await installation(t);
  const adapter = (await getProviderAdapters()).get('gigacode');
  const token = 'synthetic-native-oauth-token';
  const file = path.join(fixture.root, 'gigacode_token.json');

  await fs.writeFile(file, JSON.stringify({
    token,
    expiryDate: Date.now() + 300_000
  }), {
    mode: 0o600
  });

  const access = await adapter.auth({
    gigacodeHome: fixture.root
  });

  assert.equal(access.available, true);
  assert.equal(access.mode, 'cli-oauth');
  assert.equal(JSON.stringify(access).includes(token), false);
  assert.equal(adapter.credentials, undefined);
});

test('нет cache, истекающий cache и подмена symlink не разрешают доступ', async (t) => {
  const fixture = await installation(t);
  const adapter = (await getProviderAdapters()).get('gigacode');
  const file = path.join(fixture.root, 'gigacode_token.json');
  const config = {
    gigacodeHome: fixture.root
  };

  assert.equal((await adapter.auth(config)).available, false);

  await fs.writeFile(file, JSON.stringify({
    token: 'synthetic-expiring',
    expiryDate: Date.now() + 30_000,
  }), {
    mode: 0o600
  });

  assert.equal((await adapter.auth(config)).available, false);

  await fs.rename(file, `${file}.target`);
  await fs.symlink(`${file}.target`, file);

  assert.equal((await adapter.auth(config)).available, false);
});
