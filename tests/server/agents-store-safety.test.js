import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import agentsModule from '../../server/src/modules/agents/index.ts';
import { AgentsStore, defaults, serializeAgent } from '../../server/src/modules/agents/store.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-agents-safety-'));
  const config = {
    agentsDir: path.join(root, 'agents'),
    factoryHome: root,
    profilesDir: path.join(root, 'profiles'),
  };
  const app = Fastify({ logger: false });
  app.register(agentsModule, { config });
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, config, root };
}

test('AgentsStore сохраняет обычный CRUD атомарно и без временных хвостов', async (t) => {
  const { config } = await fixture(t);
  const store = new AgentsStore(config.agentsDir);

  await store.save('safe', { ...defaults(), label: 'Первый', prompt: 'Один' });
  assert.equal((await store.get('safe')).prompt, 'Один');
  await store.save('safe', { ...defaults(), label: 'Второй', prompt: 'Два' });
  assert.equal((await store.get('safe')).prompt, 'Два');
  assert.equal((await lstat(path.join(config.agentsDir, 'safe.md'))).isFile(), true);
  assert.deepEqual(
    (await readdir(config.agentsDir)).filter((name) => name.includes('.tmp')),
    [],
  );

  await store.remove('safe');
  assert.equal(await store.exists('safe'), false);
});

test('agents API не допускает разрыв frontmatter через метаданные', async (t) => {
  const { app, config } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/agents',
    payload: {
      id: 'injected',
      label: 'До\n---\nПодмена',
      prompt: 'Настоящий prompt',
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'invalid_agent_metadata');
  const store = new AgentsStore(config.agentsDir);
  assert.equal(await store.exists('injected'), false);
});

test('agents API не читает, не заменяет и не удаляет symlink вместо агента', async (t) => {
  const { app, config, root } = await fixture(t);
  await mkdir(config.agentsDir, { recursive: true });
  const outside = path.join(root, 'outside.md');
  const link = path.join(config.agentsDir, 'linked.md');
  const secret = serializeAgent({ ...defaults(), label: 'Снаружи', prompt: 'Секрет вне agents' });
  await writeFile(outside, secret);
  await symlink(outside, link);

  const listed = await app.inject({ method: 'GET', url: '/api/agents' });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().agents, []);

  for (const request of [
    { method: 'GET', url: '/api/agents/linked' },
    { method: 'POST', url: '/api/agents', payload: { id: 'linked', prompt: 'Перезаписать' } },
    { method: 'PUT', url: '/api/agents/linked', payload: { prompt: 'Перезаписать' } },
    { method: 'DELETE', url: '/api/agents/linked' },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 409, `${request.method} ${request.url}`);
    assert.equal(response.json().error, 'unsafe_agent_file');
  }

  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, 'utf8'), secret);
});

test('agents API отклоняет symlink в корне хранилища и в служебном .gitignore', async (t) => {
  const { app, config, root } = await fixture(t);
  const realAgents = path.join(root, 'real-agents');
  await mkdir(realAgents);
  await symlink(realAgents, config.agentsDir, 'dir');

  const unsafeRoot = await app.inject({ method: 'GET', url: '/api/agents' });
  assert.equal(unsafeRoot.statusCode, 409);
  assert.equal(unsafeRoot.json().error, 'unsafe_agents_root');
  assert.deepEqual(await readdir(realAgents), []);

  await rm(config.agentsDir);
  await mkdir(config.agentsDir);
  const outside = path.join(root, 'outside-gitignore');
  await writeFile(outside, 'не менять\n');
  await symlink(outside, path.join(config.agentsDir, '.gitignore'));

  const unsafeMetadata = await app.inject({ method: 'GET', url: '/api/agents' });
  assert.equal(unsafeMetadata.statusCode, 409);
  assert.equal(unsafeMetadata.json().error, 'unsafe_agents_root');
  assert.equal(await readFile(outside, 'utf8'), 'не менять\n');
});
