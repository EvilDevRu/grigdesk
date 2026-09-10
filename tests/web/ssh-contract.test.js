import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SshContractError,
  parseSshAccess,
  parseSshAuditPage,
  parseSshConnections,
  parseSshFiles,
  parseSshHostKeyCheck,
  parseSshSessionOpened,
  parseSshSessions,
} from '../../shared/sshContracts.ts';
import { api } from '../../web/src/shared/apiClient.ts';
import { sshApi } from '../../web/src/shared/sshApi.ts';

const connection = {
  id: 'connection-a',
  projectId: 'cockpit',
  label: 'Боевой код',
  role: 'code',
  host: 'server.internal',
  port: 22,
  user: 'deploy',
};
const session = {
  ...connection,
  id: 'session-a',
  connectionId: 'connection-a',
  agentAllowed: true,
  generation: 2,
  openedAt: '2026-09-08T08:00:00.000Z',
};
const hostKey = {
  host: 'server.internal',
  port: 22,
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:aaa',
};
const auditEntry = {
  at: '2026-09-08T08:01:00.000Z',
  projectId: 'cockpit',
  connectionId: 'connection-a',
  sessionId: 'session-a',
  label: 'Боевой код',
  role: 'code',
  host: 'server.internal',
  user: 'deploy',
  command: 'systemctl status app',
  decision: 'allow',
  comment: '',
  result: 'ok',
  exitCode: 0,
  signal: null,
  output: {
    text: 'active (running)',
    shownBytes: 16,
    totalBytes: 16,
    truncated: false,
    notice: '',
  },
};

test('контракт SSH принимает ответ сервера и отбрасывает посторонние поля', () => {
  assert.deepEqual(
    parseSshConnections({ connections: [{ ...connection, secret: 'пароль' }], extra: 1 }),
    [connection],
  );
  assert.deepEqual(parseSshSessions({ sessions: [session] }), [session]);
  assert.deepEqual(parseSshSessionOpened({ session }), session);
  assert.deepEqual(
    parseSshAuditPage({ items: [auditEntry], nextCursor: 50 }),
    { items: [auditEntry], nextCursor: 50 },
  );
});

test('решение по ключу хоста закрыто перечислением', () => {
  assert.deepEqual(
    parseSshHostKeyCheck({ status: 'trusted', decision: 'accepted', current: hostKey }),
    {
      status: 'trusted',
      decision: 'accepted',
      challengeId: null,
      previous: null,
      current: hostKey,
    },
  );
  assert.throws(
    () => parseSshHostKeyCheck({ status: 'наверное', decision: 'accepted', current: hostKey }),
    /sshHostKeyCheck\.status/,
  );
  assert.throws(
    () => parseSshHostKeyCheck({ status: 'changed', decision: 'ладно', current: hostKey }),
    /sshHostKeyCheck\.decision/,
  );
});

test('смена доступа агента различает живую сессию и машинный отказ', () => {
  assert.deepEqual(parseSshAccess(session), { session, error: null });
  assert.deepEqual(
    parseSshAccess({ ok: false, error: 'session_lost' }),
    { session: null, error: 'session_lost' },
  );
  assert.throws(() => parseSshAccess({ ok: false }), /sshAccess\.error/);
});

test('каталог различает файл и папку объявленным значением', () => {
  const files = parseSshFiles({
    files: [{ name: 'app', type: 'directory', size: 4096, mtime: 1757318400 }],
  });

  assert.deepEqual(files, [{ name: 'app', type: 'directory', size: 4096, mtime: 1757318400 }]);
  assert.throws(
    () => parseSshFiles({ files: [{ name: 'app', type: 'symlink', size: 0, mtime: 0 }] }),
    /sshFiles\.files\[0\]\.type/,
  );
});

test('адаптер кодирует идентификаторы и подтверждает форму каждого ответа', async (t) => {
  const seen = [];

  t.mock.method(api, 'get', async (url) => {
    seen.push(['GET', url]);

    if (url.includes('/files')) {
      return { files: [] };
    }

    return { sessions: [] };
  });
  t.mock.method(api, 'post', async (url, body) => {
    seen.push(['POST', url, body]);

    return { ok: true, hostKey: { ...hostKey, trustedAt: '2026-09-08T08:00:00.000Z' } };
  });
  t.mock.method(api, 'del', async (url) => {
    seen.push(['DELETE', url]);

    return { ok: true };
  });

  await sshApi.sessions();
  await sshApi.files('сессия/1', 'каталог 1');
  await sshApi.decideHostKey('вызов 1', 'trust');
  await sshApi.closeSession('сессия/1');

  const sid = encodeURIComponent('сессия/1');
  const path = encodeURIComponent('каталог 1');
  const challenge = encodeURIComponent('вызов 1');

  assert.deepEqual(seen, [
    ['GET', '/api/ssh/sessions'],
    ['GET', `/api/ssh/sessions/${sid}/files?path=${path}`],
    ['POST', `/api/ssh/host-key/${challenge}`, { decision: 'trust' }],
    ['DELETE', `/api/ssh/sessions/${sid}`],
  ]);
});

test('повреждённый ответ сети не становится сессией на экране', async (t) => {
  t.mock.method(api, 'get', async () => ({ sessions: [{ ...session, generation: 'вторая' }] }));
  t.mock.method(api, 'postBytes', async () => ({ session: { id: 'session-a' } }));

  await assert.rejects(sshApi.sessions(), SshContractError);
  await assert.rejects(sshApi.openSession('connection-a', 'пароль'), SshContractError);
});
