import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';

import { readFile, writeFile } from 'node:fs/promises';

import path from 'node:path';

import test from 'node:test';

import { createEngineRegistry } from '../../server/src/lib/db/engineRegistry.ts';

import { createDbStore } from '../../server/src/lib/db/store.ts';

import { createDbSessionManager } from '../../server/src/lib/db/sessionManager.ts';

import { createHumanDbQueries } from '../../server/src/lib/db/humanQueries.ts';

import { createDbBroker } from '../../server/src/lib/db/broker.ts';

import { createDbAudit } from '../../server/src/lib/db/audit.ts';

import { createPermissionQueue } from '../../server/src/lib/chat/permissionQueue.ts';

import { engineTree, writeEngine, adapterSource, SPI } from './helpers/dbEngineFixture.js';

for (const external of [false, true]) {
  const id = external ? 'DSPI-EXT' : 'DSPI-BASE';

  test(`${id}: общий SPI: profile/session/query/cancel/audit/direct/SSH`, { timeout: 10_000 },
    async (t) => {
      const root = await engineTree(t);

      const source = adapterSource();

      let registry;

      if (external) {
        await writeEngine(root);

        registry = await createEngineRegistry({ externalDir: root, grigDeskVersion: '1.0.0' });
      } else {
        await writeFile(path.join(root, 'fixture.mjs'), source);

        registry = await createEngineRegistry({ dir: root });
      }

      const adapter = registry.get('fixture-db');

      assert.ok(adapter, 'реестр должен загрузить произвольный драйвер');

      const store = await createDbStore({ path: path.join(root, 'profiles.json') });

      const profile = await store.create({
        projectId: 'project-a',
        label: 'Фикстура',
        engine: adapter.id,
        host: 'db.invalid',
        port: 9999,
        user: 'reader',
        role: 'read',
        via: 'direct',
        password: 'PRIVATE_PASSWORD',
      });

      const channels = [];

      const ssh = new EventEmitter();

      ssh.get = (sid) => ({
        id: sid,
        alive: true,
        projectId: 'project-a',
        generation: 1
      });

      ssh.forwardOut = async () => {
        const channel = {
          closed: false, close() {
            this.closed = true;
          }
        };

        channels.push(channel);

        return channel;
      };

      const permissionQueue = createPermissionQueue({ timeoutMs: 1000 });

      const sessions = createDbSessionManager({
        engines: registry,
        sshSessions: ssh,
        permissionQueue
      });

      t.after(() => sessions.dispose());

      const password = Buffer.from('PRIVATE_PASSWORD');

      const direct = await sessions.open({ profile, password });

      assert.equal(password.every((byte) => byte === 0), true);

      assert.equal(direct.agentAllowed, false);

      assert.equal(direct.readOnlyActive, true);

      await adapter.schema(sessions.find(direct.id).handle);

      const audit = await createDbAudit({ dir: path.join(root, 'audit') });

      const cancelledWritten = Promise.withResolvers();

      const auditPort = {
        async append(entry) {
          await audit.append(entry);

          if (entry.outcome === 'cancelled') {
            cancelledWritten.resolve();
          }
        },
      };


      const settings = () => ({
        autoRead: true,
        maxRows: 10,
        maxBytes: 1024,
        timeoutMs: 100,
        autoReadPerMinute: 10,
      });

      const broker = createDbBroker({
        pluginEnabled: () => true,
        sessions,
        engines: registry,
        permissionQueue,
        audit: auditPort,
        settings,
      });

      const request = {
        action: 'query',
        label: profile.label,
        role: 'read',
        text: 'SELECT 42'
      };

      assert.equal((await broker.invoke({ projectId: 'project-a' }, request)).ok, false);

      await sessions.setAgentAccess(direct.id, true);

      const result = await broker.invoke({ projectId: 'project-a' }, request);

      assert.equal(result.ok, true);

      assert.deepEqual(result.rows, [{ answer: 42 }]);

      assert.ok(adapter.calls.some(([name]) => name === 'inspectRights'));

      assert.ok(adapter.calls.some(([name]) => name === 'estimate'));

      const limits = adapter.calls.find(([name]) => name === 'execute')[1];

      assert.equal(limits.maxRows, 10);

      assert.equal(limits.maxBytes, 1024);

      assert.equal(limits.timeoutMs, 100);

      await sessions.setAgentAccess(direct.id, false);

      assert.equal((await broker.invoke({ projectId: 'project-a' }, request)).ok, false);

      const queries = new Map();

      const human = createHumanDbQueries({
        queries,
        sessions,
        audit: auditPort,
        settings,
        publish: () => { },
        onAuditError: (error) => {
          throw error;
        },
      });

      const waiting = await human.query(direct.id, { text: 'WAIT', params: ['PRIVATE_PARAM'] });

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal((await human.cancel(waiting.queryId)).ok, true);

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(queries.get(waiting.queryId).state, 'cancelled');

      assert.equal(queries.get(waiting.queryId).result, null);

      await cancelledWritten.promise;

      const via = await sessions.open({
        profile: { ...profile, via: 'ssh' },
        password: Buffer.from('PRIVATE_PASSWORD'),
        sshSessionId: 'ssh-a',
      });

      await sessions.close(via.id);

      await sessions.close(direct.id);

      assert.equal(channels.length, 2);

      assert.equal(channels.every((channel) => channel.closed), true);

      assert.deepEqual([...new Set(adapter.calls.map(([name]) => name))].sort(), [...SPI].sort());

      const page = await audit.list();

      assert.ok(page.items.some((item) => item.outcome === 'cancelled'));

      const visible = JSON.stringify({
        page,
        sessions: sessions.list(),
        profiles: store.list()
      });

      assert.doesNotMatch(visible, /PRIVATE_PASSWORD|PRIVATE_PARAM/u);

      assert.doesNotMatch(await readFile(path.join(root, 'profiles.json'), 'utf8'), /PRIVATE_PASSWORD/u);
    });
}
