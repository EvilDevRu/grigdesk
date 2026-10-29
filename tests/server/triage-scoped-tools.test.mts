import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { createScopedWorkspaceTools } from '../../server/src/lib/executors/scopedWorkspace.ts';
import { createWorkMcpHandler } from '../../server/src/lib/executors/work-mcp.js';
import { isRecord } from '../../shared/lib/objects.ts';

/**
 * Разрешённый код, результат и закрытый сосед существуют физически и имеют разные права брокера.
 * Проверки сравнивают файловые эффекты, включая ссылки и inode, а не только ответы инструментов.
 */
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-files-'));
  const repo = path.join(root, 'repo');
  const output = path.join(root, 'output');
  const outside = path.join(root, 'outside');

  await Promise.all([repo, output, outside].map((entry) => fs.mkdir(entry)));
  await fs.writeFile(path.join(repo, 'source.ts'), 'export const answer = 42;\n');
  await fs.writeFile(path.join(outside, 'private.txt'), 'SYNTHETIC_PRIVATE');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const scope = {
    readableRoots: [repo],
    writableRoots: [output],
    networkAccess: false,
  };
  const tools = await createScopedWorkspaceTools(scope);

  return {
    root,
    repo,
    output,
    outside,
    scope,
    tools,
  };
}

test('триаж читает и ищет код, но записывает только результат', async (t) => {
  const f = await fixture(t);
  const code = path.join(f.repo, 'source.ts');
  const read = await f.tools.invoke('read_file', { path: code });

  assert.ok(isRecord(read) && read.ok === true);
  assert.match(String(read.text), /1: export const answer = 42/u);
  assert.deepEqual(await f.tools.invoke('search_files', { path: f.repo, text: 'answer' }), {
    ok: true,
    matches: [{
      path: code,
      line: 1,
      text: 'export const answer = 42;',
    }],
    truncated: false,
  });

  const result = path.join(f.output, 'analysis.json');

  assert.deepEqual(await f.tools.invoke('write_file', { path: result, content: '{"risk":1}' }), { ok: true });
  assert.equal(await fs.readFile(result, 'utf8'), '{"risk":1}');
  assert.deepEqual(await f.tools.invoke('write_file', { path: result, content: '{}' }), { ok: true });
  assert.equal(await fs.readFile(result, 'utf8'), '{}');
});

test('закрытый сосед и запись в код недоступны независимо от аргументов модели', async (t) => {
  const f = await fixture(t);

  for (const name of ['read_file', 'read_image', 'write_file', 'list_files', 'search_files']) {
    const result = await f.tools.invoke(name, {
      path: name.endsWith('files') ? f.outside : path.join(f.outside, 'private.txt'),
      content: 'changed',
      text: 'PRIVATE',
    });

    assert.ok(isRecord(result) && result.ok === false, name);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/u);
  }

  const result = await f.tools.invoke('write_file', {
    path: path.join(f.repo, 'source.ts'), content: 'changed',
  });

  assert.ok(isRecord(result) && result.ok === false);
  assert.equal(await fs.readFile(path.join(f.repo, 'source.ts'), 'utf8'), 'export const answer = 42;\n');
  assert.equal(await fs.readFile(path.join(f.outside, 'private.txt'), 'utf8'), 'SYNTHETIC_PRIVATE');
});

test('symlink и hardlink не выводят чтение или запись за границу', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.outside, 'private.txt');

  await fs.symlink(target, path.join(f.repo, 'link'));
  await fs.symlink(f.outside, path.join(f.output, 'external'));
  await fs.link(target, path.join(f.output, 'hardlink'));

  for (const [name, file] of [
    ['read_file', path.join(f.repo, 'link')],
    ['write_file', path.join(f.output, 'external', 'private.txt')],
    ['write_file', path.join(f.output, 'hardlink')],
  ] as const) {
    const result = await f.tools.invoke(name, { path: file, content: 'changed' });

    assert.ok(isRecord(result) && result.ok === false, file);
  }

  assert.equal(await fs.readFile(target, 'utf8'), 'SYNTHETIC_PRIVATE');

  const listing = await f.tools.invoke('list_files', { path: f.repo });

  assert.ok(isRecord(listing));
  assert.deepEqual(listing.files, [path.join(f.repo, 'source.ts')]);
});

test('изображение доходит через MCP как image, без base64 в текстовом результате', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const file = path.join(f.repo, 'image.png');

  await fs.writeFile(file, bytes);

  const mcp = createWorkMcpHandler({ workTools: f.tools });
  const result = await mcp.request({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'read_image', arguments: { path: file } },
  });

  assert.ok(result && 'result' in result && isRecord(result.result));
  assert.deepEqual(result.result.content, [{
    type: 'image',
    data: bytes.toString('base64'),
    mimeType: 'image/png',
  }]);
});

test('брокер не принимает произвольные рабочие инструменты и реагирует на отмену до эффекта', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const signal = new AbortController();
  const tools = await createScopedWorkspaceTools(f.scope, {
    descriptors: [{ name: 'supervised_ssh' }],
    invoke: async () => {
      calls += 1;
    },
  }, signal.signal);

  assert.deepEqual(await tools.invoke('supervised_ssh', { command: 'forbidden' }), {
    ok: false, error: 'tool_not_found',
  });
  assert.equal(calls, 0);

  signal.abort(new Error('cancelled'));
  await assert.rejects(tools.invoke('write_file', {
    path: path.join(f.output, 'cancelled'), content: 'forbidden',
  }), /cancelled/u);
  assert.equal(await fs.stat(path.join(f.output, 'cancelled')).then(() => true, () => false), false);
});

test('читающий арбитр получает только запрошенные операции и bounded историю', async (t) => {
  const f = await fixture(t);
  let historyCalls = 0;
  const tools = await createScopedWorkspaceTools({
    ...f.scope,
    tools: ['Read', 'repo_history'],
  }, {
    descriptors: [{ name: 'repo_history' }],
    invoke: async () => {
      historyCalls += 1;

      return { commits: ['synthetic'] };
    },
  });

  assert.deepEqual(tools.descriptors.map((tool) => tool.name), ['read_file', 'read_image', 'repo_history']);
  assert.deepEqual(await tools.invoke('write_file', {
    path: path.join(f.output, 'forbidden'), content: 'forbidden',
  }), { ok: false, error: 'tool_not_found' });
  assert.deepEqual(await tools.invoke('repo_history', { operation: 'log' }), { commits: ['synthetic'] });
  assert.equal(historyCalls, 1);
  await assert.rejects(fs.access(path.join(f.output, 'forbidden')), { code: 'ENOENT' });
});
