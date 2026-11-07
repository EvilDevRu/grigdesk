import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { factorySnapshotHash } from '../../server/src/lib/mobile/factoryIdentity.ts';
import { seedFactory, seedFactoryServer, advanceFactory } from '../helpers/mobileSeed.mjs';

test('MC-38: повторный заход тех же ворот запрещает старые gate/resume/stop до CLI', async (t) => {
  const fx = await seedFactory(t, {
    cursor: {
      node: 'gate_accept',
      state: 'paused',
    },
  });
  const app = await seedFactoryServer(t, fx);
  const identity = (await app.inject('/api/tasks/7/mobile-state')).json().identity;

  assert.equal(identity.sequence, 8);
  await advanceFactory(fx);

  for (const path of ['gate/GATE_ACCEPT/approve', 'resume', 'stop']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/7/' + path,
      payload: { expectedMobile: identity },
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'state_changed');
  }

  await assert.rejects(readFile(fx.callsLog), { code: 'ENOENT' });
});

test('MC-38: fingerprint запуска включает все поля и не зависит от порядка JSON', () => {
  const first = {
    profile: 'demo',
    routes: ['feature'],
    catalogHash: 'a'.repeat(64),
    runners: ['one'],
  };

  assert.equal(
    factorySnapshotHash(first),
    factorySnapshotHash({
      runners: ['one'],
      catalogHash: 'a'.repeat(64),
      routes: ['feature'],
      profile: 'demo',
    }),
  );
  assert.notEqual(
    factorySnapshotHash(first),
    factorySnapshotHash({
      ...first,
      runners: ['two'],
    }),
  );
});

test('MC-38: owner повторно проверяет основание внутри общего допуска', async (t) => {
  const fx = await seedFactory(t, {
    cursor: {
      node: 'gate_accept',
      state: 'paused',
    },
  });
  const app = await seedFactoryServer(t, fx);
  const { writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const identity = (await app.inject('/api/tasks/7/mobile-state')).json().identity;

  await writeFile(path.join(fx.stateDir, 't7.report.md'), 'Новое основание');

  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/approve',
    payload: {
      expectedMobile: identity,
      expectedBasis: {
        name: 'report',
        hash: factorySnapshotHash('Прочитанное старое основание'),
      },
    },
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'state_changed');
  await assert.rejects(readFile(fx.callsLog), { code: 'ENOENT' });
});

test('MC-38: параллельные web/mobile ворота применяются один раз у общего owner', async (t) => {
  const fx = await seedFactory(t, {
    cursor: {
      node: 'gate_accept',
      state: 'paused',
    },
  });
  const app = await seedFactoryServer(t, fx);
  const { writeFile, chmod } = await import('node:fs/promises');
  const path = await import('node:path');
  const identity = (await app.inject('/api/tasks/7/mobile-state')).json().identity;
  const runtime = path.join(
    fx.controlDir,
    'protocol-v2',
    'tasks',
    't7',
    'attempts',
    identity.attempt,
    'stage-results',
    'runtime.json',
  );
  const next = path.join(fx.root, 'next-runtime.json');

  await advanceFactory(fx);
  await writeFile(next, await readFile(runtime));
  await chmod(runtime, 0o600);

  const envelope = JSON.parse(await readFile(runtime, 'utf8'));

  envelope.runtime.sequence = 8;

  const { createHash } = await import('node:crypto');
  const canonical = (value) =>
    value === null || typeof value !== 'object'
      ? JSON.stringify(value)
      : Array.isArray(value)
        ? '[' + value.map(canonical).join(',') + ']'
        : '{' +
          Object.keys(value)
            .sort()
            .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
            .join(',') +
          '}';

  envelope.checksum = createHash('sha256')
    .update(canonical(envelope.runtime) + '\n')
    .digest('hex');
  await writeFile(runtime, JSON.stringify(envelope));
  await writeFile(
    fx.config.factoryBin,
    '#!/usr/bin/env bash\n' +
      `printf '%s\\n' "$*" >> '${fx.callsLog}'\n` +
      `cp '${next}' '${runtime}'\n`,
    { mode: 0o755 },
  );

  const [web, mobile] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/tasks/7/gate/GATE_ACCEPT/approve',
      payload: {},
    }),
    app.inject({
      method: 'POST',
      url: '/api/tasks/7/gate/GATE_ACCEPT/approve',
      payload: { expectedMobile: identity },
    }),
  ]);

  assert.equal(web.statusCode, 200, web.body);
  assert.equal(mobile.statusCode, 409, mobile.body);
  assert.equal((await readFile(fx.callsLog, 'utf8')).trim().split('\n').length, 1);
});
