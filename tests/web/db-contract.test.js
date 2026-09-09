import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DbContractError,
  parseDbAccess,
  parseDbAuditPage,
  parseDbCancel,
  parseDbProfiles,
  parseDbQueries,
  parseDbSchema,
  parseDbSessions,
} from '../../shared/dbContracts.ts';
import { api } from '../../web/src/shared/api-client.js';
import { dbApi } from '../../web/src/shared/dbApi.ts';

const PROFILE = {
  id: 'profile-a',
  projectId: 'cockpit',
  label: 'Боевая',
  role: 'read',
  engine: 'mysql',
  host: 'db.internal',
  port: 3306,
  user: 'reader',
  database: 'shop',
  prod: true,
  via: 'ssh',
};
const SESSION = {
  id: 'session-a',
  profileId: 'profile-a',
  projectId: 'cockpit',
  label: 'Боевая',
  role: 'read',
  engine: 'mysql',
  prod: true,
  via: 'ssh',
  agentAllowed: false,
  generation: 1,
  readOnlyActive: true,
  openedAt: '2026-09-08T08:00:00.000Z',
};
const RESULT = {
  rows: [{ id: 1, name: 'заказ' }],
  shownRows: 1,
  totalRows: 1,
  shownBytes: 32,
  totalBytes: 32,
  truncated: false,
  untrusted: true,
  notice: null,
};

test('профиль и сессия не выносят наружу пароль и посторонние поля', () => {
  assert.deepEqual(
    parseDbProfiles({ profiles: [{ ...PROFILE, password: 'секрет', handle: {} }] }),
    [PROFILE],
  );
  assert.deepEqual(parseDbSessions({ sessions: [SESSION] }), [SESSION]);
  assert.equal(JSON.stringify(parseDbSessions({ sessions: [SESSION] })).includes('handle'), false);
});

test('роль подключения и способ доступа закрыты перечислениями', () => {
  assert.throws(
    () => parseDbProfiles({ profiles: [{ ...PROFILE, role: 'админ' }] }),
    /dbProfiles\.profiles\[0\]\.role/,
  );
  assert.throws(
    () => parseDbProfiles({ profiles: [{ ...PROFILE, via: 'вручную' }] }),
    /dbProfiles\.profiles\[0\]\.via/,
  );
});

test('строки ответа базы формы не обещают, а счёт показанного — обещает', () => {
  const schema = parseDbSchema({ schema: { ...RESULT, rows: [1, 'две', { три: null }, []] } });

  assert.deepEqual(schema.rows, [1, 'две', { три: null }, []]);
  assert.equal(schema.shownRows, 1);
  assert.throws(
    () => parseDbSchema({ schema: { ...RESULT, shownRows: 'одна' } }),
    /dbSchema\.schema\.shownRows/,
  );
});

test('прерванный запрос не выдаёт показанное за полный счёт', () => {
  const partial = parseDbSchema({
    schema: { ...RESULT, totalRows: null, totalBytes: null, truncated: true },
  });

  assert.deepEqual({ totalRows: partial.totalRows, truncated: partial.truncated }, {
    totalRows: null,
    truncated: true,
  });
});

test('результат запроса различает ответ базы и машинный отказ', () => {
  const [done] = parseDbQueries({
    queries: [{
      id: 'query-a',
      sessionId: 'session-a',
      actor: 'human',
      text: 'SELECT 1',
      state: 'done',
      startedAt: '2026-09-08T08:00:00.000Z',
      result: RESULT,
    }],
  });
  const [failed] = parseDbQueries({
    queries: [{
      id: 'query-b',
      sessionId: 'session-a',
      actor: 'agent',
      text: 'SELECT 1',
      state: 'error',
      startedAt: '2026-09-08T08:00:00.000Z',
      result: { ok: false, error: 'query_failed' },
    }],
  });

  assert.equal(done.result.untrusted, true);
  assert.deepEqual(failed.result, { ok: false, error: 'query_failed' });
  assert.equal(done.queryClass, null, 'нераспознанный род запроса — пустое место');
});

test('исход отмены сохраняет способ, которым запрос удалось снять', () => {
  assert.deepEqual(parseDbCancel({ ok: true, method: 'connection' }), {
    ok: true,
    method: 'connection',
    error: null,
  });
  assert.deepEqual(parseDbCancel({ ok: false, error: 'cancel_not_supported' }), {
    ok: false,
    method: null,
    error: 'cancel_not_supported',
  });
});

test('смена доступа агента различает живую сессию и машинный отказ', () => {
  assert.deepEqual(parseDbAccess(SESSION), { session: SESSION, error: null });
  assert.deepEqual(parseDbAccess({ ok: false, error: 'session_lost' }), {
    session: null,
    error: 'session_lost',
  });
});

test('журнал переживает отсутствие необязательных полей', () => {
  const page = parseDbAuditPage({ items: [{ at: '2026-09-08T08:00:00.000Z' }] });

  assert.deepEqual({ rows: page.items[0].rows, outcome: page.items[0].outcome }, {
    rows: null,
    outcome: null,
  });
  assert.equal(page.nextCursor, null);
});

test('адаптер кодирует идентификаторы и подтверждает форму каждого ответа', async (t) => {
  const seen = [];

  t.mock.method(api, 'get', async (url) => {
    seen.push(['GET', url]);

    return url.includes('/schema') ? { schema: RESULT } : { sessions: [] };
  });
  t.mock.method(api, 'del', async (url) => {
    seen.push(['DELETE', url]);

    return { ok: true };
  });

  await dbApi.sessions();
  await dbApi.schema('сессия/1');
  await dbApi.deleteProfile('профиль/1');

  const sid = encodeURIComponent('сессия/1');
  const profileId = encodeURIComponent('профиль/1');

  assert.deepEqual(seen, [
    ['GET', '/api/db/sessions'],
    ['GET', `/api/db/sessions/${sid}/schema`],
    ['DELETE', `/api/db/profiles/${profileId}`],
  ]);
});

test('повреждённый ответ сети не становится сессией на экране', async (t) => {
  t.mock.method(api, 'get', async () => ({ sessions: [{ ...SESSION, generation: 'вторая' }] }));
  t.mock.method(api, 'post', async () => ({ queryId: 42 }));

  await assert.rejects(dbApi.sessions(), DbContractError);
  await assert.rejects(dbApi.runQuery('session-a', 'SELECT 1'), DbContractError);
});
