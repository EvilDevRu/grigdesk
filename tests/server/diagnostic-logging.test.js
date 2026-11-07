import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import {
  DiagnosticLoggingPolicy,
  serverLogLevel,
} from '../../server/src/lib/diagnosticLogging.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

test('одна глобальная настройка обновляет диагностический logger сервера', async (t) => {
  let level = 'off';
  const factoryDebug = {
    show: async () => ({ effective: level }),
    set: async (target) => {
      level = target.level;

      return { effective: level };
    },
    clear: async () => {
      level = 'off';

      return { effective: level };
    },
  };
  const policy = new DiagnosticLoggingPolicy(factoryDebug);
  const app = Fastify({ logger: { level: 'info' } });

  t.after(() => app.close());
  const stop = policy.subscribe((value) => {
    app.log.level = serverLogLevel(value);
  });

  assert.equal(await policy.level(), 'off');
  assert.equal(app.log.level, 'silent');
  await policy.set('errors');
  assert.equal(app.log.level, 'error');
  await policy.set('decisions');
  assert.equal(app.log.level, 'info');
  await policy.set('verbose');
  assert.equal(app.log.level, 'debug');
  factoryDebug.show = async () => { throw new Error('settings unavailable'); };
  await assert.rejects(policy.level(), /settings unavailable/u);
  assert.equal(app.log.level, 'silent');
  await policy.clear();
  assert.equal(app.log.level, 'silent');
  stop();
});
