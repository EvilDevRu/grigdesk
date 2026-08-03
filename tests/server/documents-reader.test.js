import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DocumentReader } from '../../server/src/lib/documents/reader.js';
import documentsModule from '../../server/src/modules/documents/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t, { maxBytes = 1024 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-documents-'));
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const reader = new DocumentReader({
    maxBytes,
    rootProviders: [() => [{ id: 'test', label: 'Тест', path: root }]],
  });
  return { dir, root, outside, reader };
}

test('DOC-01: читает UTF-8 Markdown только из зарегистрированного корня', async (t) => {
  const { root, reader } = await fixture(t);
  const file = path.join(root, 'план.md');
  await fs.writeFile(file, '# План\n\nТекст.\n');

  const resolved = await reader.resolveAbsolute(file);
  const document = await reader.read(resolved.ref);

  assert.equal(document.content, '# План\n\nТекст.\n');
  assert.equal(document.format, 'markdown');
  assert.equal(document.displayPath, 'план.md');
  assert.deepEqual(document.source, { id: 'test', label: 'Тест' });
  assert.deepEqual(document.ref, { source: 'test', path: 'план.md' });
});

test('DOC-02: путь вне корня и symlink-выход запрещены', async (t) => {
  const { root, outside, reader } = await fixture(t);
  const secret = path.join(outside, 'secret.txt');
  const link = path.join(root, 'link.txt');
  await fs.writeFile(secret, 'секрет');
  await fs.symlink(secret, link);

  await assert.rejects(() => reader.resolveAbsolute(secret), { code: 'document_outside_roots', statusCode: 403 });
  await assert.rejects(() => reader.read({ source: 'test', path: 'link.txt' }), { code: 'document_outside_roots', statusCode: 403 });
});

test('DOC-03: разрешены только MD/TXT, бинарный и слишком большой файл не читаются', async (t) => {
  const { root, reader } = await fixture(t, { maxBytes: 8 });
  const json = path.join(root, 'data.json');
  const binary = path.join(root, 'binary.txt');
  const large = path.join(root, 'large.md');
  await fs.writeFile(json, '{}');
  await fs.writeFile(binary, Buffer.from([0x61, 0x00, 0x62]));
  await fs.writeFile(large, '123456789');

  await assert.rejects(() => reader.read({ source: 'test', path: 'data.json' }), { code: 'document_type_not_allowed', statusCode: 415 });
  await assert.rejects(() => reader.read({ source: 'test', path: 'binary.txt' }), { code: 'document_binary', statusCode: 415 });
  await assert.rejects(() => reader.read({ source: 'test', path: 'large.md' }), { code: 'document_too_large', statusCode: 413 });
});

test('DOC-04: HTTP-модуль отдаёт документ без кэширования и типизированные ошибки', async (t) => {
  const { root, outside, reader } = await fixture(t);
  const file = path.join(root, 'note.txt');
  await fs.writeFile(file, 'заметка');
  await fs.writeFile(path.join(outside, 'note.txt'), 'снаружи');
  const app = Fastify({ logger: false });
  await app.register(documentsModule, { reader });
  t.after(() => app.close());

  const ok = await app.inject({
    method: 'GET',
    url: '/api/documents/file?source=test&path=note.txt',
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['cache-control'], 'private, no-store');
  assert.equal(ok.json().content, 'заметка');

  const resolved = await app.inject({
    method: 'POST',
    url: '/api/documents/resolve',
    payload: { path: file },
  });
  assert.deepEqual(resolved.json().ref, { source: 'test', path: 'note.txt' });

  const denied = await app.inject({
    method: 'GET',
    url: '/api/documents/file?source=test&path=..%2Foutside%2Fnote.txt',
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, 'document_outside_roots');

  const bad = await app.inject({ method: 'GET', url: '/api/documents/file' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'document_ref_required');
  assert.equal(bad.headers['cache-control'], 'private, no-store');
});

test('DOC-05: providers подключаются независимо, конфликт source id закрывается отказом', async (t) => {
  const { dir, reader } = await fixture(t);
  const extra = path.join(dir, 'extra');
  await fs.mkdir(extra);
  await fs.writeFile(path.join(extra, 'more.md'), '# Ещё\n');
  reader.addRootProvider(() => [{ id: 'extra', label: 'Дополнение', path: extra }]);

  const added = await reader.read({ source: 'extra', path: 'more.md' });
  assert.equal(added.content, '# Ещё\n');
  assert.equal(added.source.label, 'Дополнение');

  reader.addRootProvider(() => [{ id: 'test', label: 'Конфликт', path: extra }]);
  await assert.rejects(() => reader.roots(), {
    code: 'document_source_conflict',
    statusCode: 500,
  });
});

test('DOC-06: локальные растровые изображения доступны только внутри source', async (t) => {
  const { root, outside, reader } = await fixture(t);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets', 'logo.png'), png);
  await fs.writeFile(path.join(outside, 'secret.png'), png);
  await fs.symlink(path.join(outside, 'secret.png'), path.join(root, 'assets', 'secret.png'));

  const asset = await reader.readAsset({ source: 'test', path: 'assets/logo.png' });
  assert.equal(asset.contentType, 'image/png');
  assert.deepEqual(asset.content, png);
  await assert.rejects(
    () => reader.readAsset({ source: 'test', path: 'assets/secret.png' }),
    { code: 'document_outside_roots', statusCode: 403 },
  );
  await assert.rejects(
    () => reader.readAsset({ source: 'test', path: 'assets/logo.svg' }),
    { code: 'document_asset_type_not_allowed', statusCode: 415 },
  );

  const app = Fastify({ logger: false });
  await app.register(documentsModule, { reader });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'GET',
    url: '/api/documents/asset?source=test&path=assets%2Flogo.png',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(response.rawPayload, png);
});
