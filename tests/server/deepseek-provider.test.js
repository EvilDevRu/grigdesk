import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  deepSeekAuth,
  deepSeekCatalogCacheKey,
  deepSeekSeedModels,
  parseDeepSeekConfigOptions,
  readDeepSeekCatalog,
} from '../../server/src/lib/deepseek/catalog.ts';
import { writeDeepSeekMetadataStub } from '../helpers/deepseekBinaryStub.mts';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import {
  deepSeekAuthProfileId,
  deepSeekSecurityProfile,
} from '../../server/src/lib/executors/deepseek.ts';
import { getExecutor, getProviderAdapters } from '../../server/src/lib/executors/index.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_ACP = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/fakeAcp.mts');
const METADATA = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/metadata/probe-no-key.json');

test('парсер сохраняет opaque model id и берёт efforts только из configOptions', async () => {
  const fixture = JSON.parse(await fs.readFile(METADATA, 'utf8'));
  const parsed = parseDeepSeekConfigOptions(fixture.configOptions);
  assert.equal(parsed.currentModel, '["deepseek-official","deepseek-v4-flash"]');
  assert.equal(parsed.currentEffort, 'high');
  assert.deepEqual(parsed.efforts, ['off', 'low', 'high', 'max']);
  assert.deepEqual(parsed.models.map((model) => [model.id, model.name, model.family]), [
    ['["deepseek-official","deepseek-flash"]', 'DeepSeek-V41-Flash', undefined],
    ['["deepseek-official","deepseek-v4-flash"]', 'DeepSeek-V4-Flash', undefined],
    ['["deepseek-official","deepseek-v4-pro"]', 'DeepSeek-V4-Pro', undefined],
    ['["deepseek-official","deepseek-v4-flash-vision-exp"]', 'DeepSeek-V4-Flash-Vision-Exp', undefined],
  ]);
  // Общее семейство на все модели краткий список прочёл бы как версии одной модели.
  assert.equal(deepSeekSeedModels().some((model) => 'family' in model), false);
  assert.equal(String(deepseek.modelFamily?.({ id: 'deepseek-v4-pro' }) ?? ''), '');
  assert.deepEqual(parsed.models.map((model) => model.efforts), [
    parsed.efforts, parsed.efforts, parsed.efforts, parsed.efforts,
  ]);
});

test('auth и cache key зависят от наличия ключа, но не раскрывают его', async (t) => {
  const secret = 'synthetic-deepseek-key-never-print';
  assert.deepEqual(deepSeekAuth({}), {
    mode: 'env',
    label: 'нужен DEEPSEEK_API_KEY в окружении службы',
    available: false,
  });
  assert.deepEqual(deepSeekAuth({ DEEPSEEK_API_KEY: secret }), {
    mode: 'env',
    label: 'ключ в окружении службы',
    available: true,
  });

  const { binary, root } = await writeDeepSeekMetadataStub(t);
  const config = { deepseekBin: binary, deepseekRuntimeHome: root };
  const first = await deepSeekCatalogCacheKey(config, { DEEPSEEK_API_KEY: secret });
  const second = await deepSeekCatalogCacheKey(config, { DEEPSEEK_API_KEY: `${secret}-other` });
  assert.notEqual(first, second);
  assert.equal(first.includes(secret), false);
  assert.match(first, /9\.2\.0/u);
});

test('metadata probe делает initialize/new/close без prompt и возвращает каталог', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-deepseek-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const metadata = JSON.parse(await fs.readFile(METADATA, 'utf8'));
  const { binary } = await writeDeepSeekMetadataStub(t);
  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake.ndjson');
  await fs.writeFile(scenarioFile, JSON.stringify({ configOptions: metadata.configOptions }));

  const result = await readDeepSeekCatalog({
    config: { deepseekRuntimeHome: root, deepseekBin: binary },
    env: { ...process.env, DEEPSEEK_API_KEY: 'synthetic-catalog-key' },
  }, {
    spawnProcess: (_command, _args, options) => spawn(process.execPath, [
      FAKE_ACP, '--scenario', scenarioFile, '--log', logFile,
    ], { detached: options.detached, stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  assert.equal(result.models.length, 4);
  const methods = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter((entry) => entry.kind === 'request')
    .map((entry) => entry.message.method);
  assert.deepEqual(methods, ['initialize', 'session/new', 'session/close']);

  // Повторный probe в том же runtime home: синтетический project с `.git` уже существует,
  // и это не должно ронять каталог обратно в seed или оставлять launch-каталоги.
  const again = await readDeepSeekCatalog({
    config: { deepseekRuntimeHome: root, deepseekBin: binary },
    env: { ...process.env, DEEPSEEK_API_KEY: 'synthetic-catalog-key' },
  }, {
    spawnProcess: (_command, _args, options) => spawn(process.execPath, [
      FAKE_ACP, '--scenario', scenarioFile, '--log', logFile,
    ], { detached: options.detached, stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  assert.equal(again.models.length, 4);

  const generations = await fs.readdir(path.join(root, 'catalog'));

  assert.equal(generations.length, 1);
  assert.deepEqual(await fs.readdir(path.join(root, 'catalog', generations[0], 'launch')), []);
});

test('адаптер объявляет полный честный контракт и виден обоим реестрам', async () => {
  assert.equal((await getProviderAdapters()).get('deepseek'), deepseek);
  assert.equal(await getExecutor('deepseek'), deepseek);
  assert.deepEqual([
    deepseek.id, deepseek.name, deepseek.vendor, deepseek.color, deepseek.order,
  ], ['deepseek', 'DeepSeek', 'DeepSeek', '#4D6BFE', 4]);
  assert.equal(deepseek.workToolsTransport, 'mcp');
  assert.equal(typeof deepseek.sessionBinding.authProfileId, 'function');
  assert.equal(deepseek.retryContract, 'pre_prompt_only');
  assert.deepEqual(deepseek.compaction, { kind: 'summary' });
  assert.equal(typeof deepseek.run, 'function');
  assert.equal(deepseek.session, undefined);
  assert.equal(deepseek.untrustedInput, undefined);
  assert.equal(deepseek.scopedWorkspace, undefined);
  assert.deepEqual(deepseek.workdir, { switch: 'reseed', roots: 'single' });

  const modes = await deepseek.modes();
  assert.deepEqual(modes.map((mode) => mode.id), ['default', 'auto', 'read-only']);
  assert.equal(modes[0].label, 'Спрашивать');
  assert.match(modes[0].hint, /требуют разрешения/iu);
  assert.match(modes[1].hint, /песочнице.*расширение доступа/iu);
  assert.doesNotMatch(modes[0].hint, /перед кажд/iu);
  assert.equal(deepSeekSeedModels().length, 1);
});

test('DeepSeek session identity пинит ключ и профиль без раскрытия ключа', () => {
  const secret = 'synthetic-binding-key';
  const auth = deepSeekAuthProfileId({ DEEPSEEK_API_KEY: secret });
  const secure = deepSeekSecurityProfile({ blockDirectSsh: true, blockDirectDb: false });
  const changed = deepSeekSecurityProfile({ blockDirectSsh: false, blockDirectDb: false });
  assert.match(auth, /^deepseek-env-key:[a-f0-9]{16}$/u);
  assert.equal(auth.includes(secret), false);
  assert.match(secure, /^deepseek-host-sandbox-v6:[a-f0-9]{64}$/u);
  assert.notEqual(secure, changed);
});
