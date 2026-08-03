import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import agentsModule from '../../server/src/modules/agents/index.js';
import { AgentsStore, defaults, serializeAgent } from '../../server/src/modules/agents/store.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_SEED_DIR = path.join(REPO_ROOT, 'server', 'seed', 'agents');

async function fixture(t, { seedFiles = {}, seedDir } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-agents-install-'));
  const config = {
    agentsDir: path.join(root, 'agents'),
    agentsSeedDir: seedDir || path.join(root, 'seed'),
    factoryHome: root,
    profilesDir: path.join(root, 'profiles'),
  };
  if (!seedDir && seedFiles) {
    await mkdir(config.agentsSeedDir, { recursive: true });
    for (const [name, text] of Object.entries(seedFiles)) {
      await writeFile(path.join(config.agentsSeedDir, name), text);
    }
  }
  const app = Fastify({ logger: false });
  app.register(agentsModule, { config });
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, config, root };
}

const seedAgent = (label, prompt) => serializeAgent({ ...defaults(), label, prompt });

test('install создаёт только отсутствующих и идемпотентен', async (t) => {
  const { app, config } = await fixture(t, {
    seedFiles: { 'alpha.md': seedAgent('Альфа', 'Промпт альфы'), 'beta.md': seedAgent('Бета', 'Промпт беты') },
  });
  // Пользовательский агент с тем же id, что в посеве, — перетирать его нельзя.
  const store = new AgentsStore(config.agentsDir);
  await store.save('alpha', { ...defaults(), label: 'Своя альфа', prompt: 'Ручная правка' });

  const first = await app.inject({ method: 'POST', url: '/api/agents/install' });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { ok: true, created: ['beta'], skipped: ['alpha'] });
  assert.equal((await store.get('alpha')).prompt, 'Ручная правка');
  assert.equal((await store.get('beta')).prompt, 'Промпт беты');

  const second = await app.inject({ method: 'POST', url: '/api/agents/install' });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), { ok: true, created: [], skipped: ['alpha', 'beta'] });
});

test('install игнорирует мусор в каталоге посева', async (t) => {
  const { app, config, root } = await fixture(t, {
    seedFiles: {
      'good.md': seedAgent('Хороший', 'Промпт'),
      'BAD ID.md': seedAgent('Плохой id', 'Не должен попасть'),
      'notes.txt': 'не markdown',
    },
  });
  // symlink на файл вне посева не читаем.
  const outside = path.join(root, 'outside.md');
  await writeFile(outside, seedAgent('Снаружи', 'Секрет'));
  await symlink(outside, path.join(config.agentsSeedDir, 'linked.md'));

  const response = await app.inject({ method: 'POST', url: '/api/agents/install' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, created: ['good'], skipped: [] });
  const store = new AgentsStore(config.agentsDir);
  assert.equal(await store.exists('linked'), false);
});

test('install без каталога посева — понятная 500, библиотека не меняется', async (t) => {
  const { app, config } = await fixture(t, { seedFiles: null });
  const response = await app.inject({ method: 'POST', url: '/api/agents/install' });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error, 'agents_seed_missing');
  assert.equal((await new AgentsStore(config.agentsDir).list()).length, 0);
});

test('закоммиченный стандартный набор валиден и ставится целиком', async (t) => {
  const { app, config } = await fixture(t, { seedDir: REAL_SEED_DIR });

  const response = await app.inject({ method: 'POST', url: '/api/agents/install' });
  assert.equal(response.statusCode, 200);
  const { created, skipped } = response.json();
  assert.ok(created.length >= 25, `ожидался полный набор, получено ${created.length}`);
  assert.deepEqual(skipped, []);

  // Каждый установленный агент читается обратно и несёт подпись и промпт.
  const store = new AgentsStore(config.agentsDir);
  for (const id of created) {
    const agent = await store.get(id);
    assert.ok(agent.label, `${id}: пустая подпись`);
    assert.ok(agent.prompt, `${id}: пустой промпт`);
    // Прямое чтение файла тоже обязано парситься (формат не сломан при копировании).
    const raw = await readFile(path.join(config.agentsDir, `${id}.md`), 'utf8');
    assert.ok(raw.startsWith('---\n'), `${id}: нет frontmatter`);
  }
});
