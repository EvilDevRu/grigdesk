import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function load(relative, contract) {
  try {
    return await import(new URL(relative, import.meta.url));
  } catch (error) {
    assert.fail(`${contract}: ${error.message}`);
  }
}

test('результат режется по строкам и помечается недоверенным', async () => {
  const module = await load(
    '../../server/src/lib/db/result.ts',
    'нормализатор недоверенного DB-результата ещё не реализован',
  );
  const normalize = module.normalizeDbResult || module.limitDbResult || module.default;
  const rows = [
    { id: 1, value: '\u001b[31mкрасный\u001b[0m' },
    { id: 2, value: 'обычный' },
    { id: 3, value: 'очень-длинное-значение' },
  ];
  const result = await normalize(rows, { maxRows: 2, maxBytes: 4096, completed: true });

  assert.deepEqual({
    untrusted: result.untrusted,
    shownRows: result.shownRows,
    totalRows: result.totalRows,
    truncated: result.truncated,
    ansi: JSON.stringify(result.rows).includes('\u001b['),
    honestNotice: result.notice?.includes(`показано ${result.shownRows} из 3`),
  }, {
    untrusted: true,
    shownRows: 2,
    totalRows: 3,
    truncated: true,
    ansi: false,
    honestNotice: true,
  });
});

test('байтовый бюджет сохраняет только целые строки и честное число N из M', async () => {
  const module = await load(
    '../../server/src/lib/db/result.ts',
    'байтовый срез недоверенного DB-результата ещё не реализован',
  );
  const normalize = module.normalizeDbResult || module.limitDbResult || module.default;
  const rows = [
    { id: 1, value: 'коротко' },
    { id: 2, value: 'длинное-значение'.repeat(20) },
    { id: 3, value: 'хвост' },
  ];
  const firstRowBytes = Buffer.byteLength(JSON.stringify(rows[0]), 'utf8');
  const maxBytes = firstRowBytes + 4;
  const result = await normalize(rows, { maxRows: 10, maxBytes, completed: true });

  assert.deepEqual({
    shownRows: result.shownRows,
    actualRows: result.rows.length,
    totalRows: result.totalRows,
    truncated: result.truncated,
    byteBudgetKept: Buffer.byteLength(JSON.stringify(result.rows[0]), 'utf8') <= maxBytes,
    wholeSecondRowExcluded: result.rows.some((row) => row.id === 2),
    honestNotice: result.notice?.includes('показано 1 из 3'),
  }, {
    shownRows: 1,
    actualRows: 1,
    totalRows: 3,
    truncated: true,
    byteBudgetKept: true,
    wholeSecondRowExcluded: false,
    honestNotice: true,
  });
});

test('прерванный поток не выдумывает полное число строк', async () => {
  const module = await load(
    '../../server/src/lib/db/result.ts',
    'нормализатор прерванного DB-результата ещё не реализован',
  );
  const normalize = module.normalizeDbResult || module.limitDbResult || module.default;
  const result = await normalize([{ id: 1 }, { id: 2 }], {
    maxRows: 1,
    maxBytes: 1024,
    completed: false,
  });

  assert.deepEqual({
    shownRows: result.shownRows,
    totalRows: result.totalRows,
    truncated: result.truncated,
  }, {
    shownRows: 1,
    totalRows: null,
    truncated: true,
  });
});

test('журнал хранит авторазрешённый запрос без значений строк и пароля', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-db-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = await load(
    '../../server/src/lib/db/audit.ts',
    'приватный 30-дневный DB-журнал ещё не реализован',
  );
  const create = module.createDbAudit || module.default;
  const sentinel = 'DB_PASSWORD_SENTINEL_91012';
  const rowSecret = 'DB_ROW_SECRET_91012';
  const audit = await create({ dir: root, now: () => new Date('2026-09-02T10:00:00.000Z') });
  await audit.append({
    projectId: 'project-a',
    sessionId: 'session-a',
    actor: 'agent',
    query: 'SELECT value FROM secrets',
    queryClass: 'read',
    tables: ['secrets'],
    decision: 'auto_allow',
    outcome: 'success',
    rows: 1,
    bytes: 24,
    truncated: false,
    result: [{ value: rowSecret }],
    password: sentinel,
  });
  const names = await readdir(root, { recursive: true });
  const log = names.find((name) => name.endsWith('.ndjson'));
  const raw = await readFile(path.join(root, log), 'utf8');
  const page = await audit.list({ limit: 10 });

  assert.deepEqual({
    decisions: page.items.map((item) => item.decision),
    passwordLeak: raw.includes(sentinel),
    rowLeak: raw.includes(rowSecret),
  }, {
    decisions: ['auto_allow'],
    passwordLeak: false,
    rowLeak: false,
  });
});

test('очистка журнала удаляет записи старше тридцати дней', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-db-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, '2026-07-01.ndjson'), '{"query":"old"}\n');
  const module = await load(
    '../../server/src/lib/db/audit.ts',
    'очистка DB-журнала ещё не реализована',
  );
  const create = module.createDbAudit || module.default;
  const audit = await create({ dir: root, now: () => new Date('2026-09-02T10:00:00.000Z') });
  await audit.append({ query: 'fresh', actor: 'human', outcome: 'success' });
  await audit.cleanup();

  assert.deepEqual(
    (await readdir(root)).sort(),
    ['2026-09-02.ndjson'],
  );
});
