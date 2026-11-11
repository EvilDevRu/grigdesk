import claude from '../../../server/src/lib/executors/claude.ts';
import deepseek from '../../../server/src/lib/executors/deepseek.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FactoryStateAdapter } from '../../../server/src/adapters/factoryState.ts';
import { spawnRouteEngine } from '../../../server/src/lib/factoryRouteCli.ts';
import {
  base, deferred, eventually, profileFixture, resolvedAdapter, runChat, saveChat,
} from '../../helpers/accessProfiles.js';

const cleanups = [];
const testContext = { after: (callback) => cleanups.push(callback) };
const nativeFetch = globalThis.fetch;
let fixture;
let running;
const factoryChildren = new Set();

/**
 * Настоящий trusted reader читает ledger временной задачи, каталог задаётся как у соседней фикстуры.
 * HTTP preflight и запуск не подменяются: fake executable заменяет лишь движок и systemd.
 */
function factoryState(config) {
  const adapter = new FactoryStateAdapter({
    stateDir: config.stateDir,
    controlDir: config.factoryControlDir,
    profilesDir: config.profilesDir,
    routesDir: config.routesDir,
  });

  adapter.getTaskGraph = async () => ({ keys: { build: 'BUILD' } });
  adapter.catalog = async () => ({
    routes: ['feature'],
    catalogHash: 'b'.repeat(64),
    routeOptions: { feature: {
      deliveryMode: 'disabled',
      instrumentationMode: 'disabled',
      instrumentationRequired: false,
    } },
  });

  return adapter;
}

/**
 * Worker имеет собственную память приложения и общую только папку состояния.
 * Родитель управляет моментом входа, а блокировки и выбор доступа выполняет продукт.
 */
async function dispatch(message) {
  if (message.command === 'boot') {
    const vendor = {
      origin: message.vendorOrigin,
      calls: [],
      control: {},
      fetchImpl: (url, init) => nativeFetch(`${message.vendorOrigin}${new URL(url).pathname}`, init),
    };

    fixture = await profileFixture(testContext, {
      root: message.root,
      env: message.env,
      vendor,
      config: message.config,
      ...(message.config.accessFactoryFixture ? { factoryState: factoryState(message.config) } : {}),
      fault(point) {
        if (point === message.faultPoint) {
          process.exit(87);
        }
      },
      ...(message.provider === 'claude' ? { adapters: [claude] } : {}),
      ...(message.provider === 'deepseek' ? { adapters: [deepseek] } : {}),
    });

    return { ready: true };
  }

  if (message.command === 'start') {
    fixture.control.hold = deferred();
    fixture.control.entered = deferred();
    fixture.control.beforeSpawn = () => {
      if (message.poisonEnvironment) {
        process.env.DEEPSEEK_API_KEY = 'synthetic-process-env-before-spawn';
        fixture.env.DEEPSEEK_API_KEY = 'synthetic-service-env-before-spawn';
      }
    };

    const chatKey = message.chatId ?? 'worker-chat';

    await saveChat(fixture, 'synthetic-access', chatKey);
    running = runChat(fixture, { chatKey });

    const call = await fixture.control.entered.promise;

    return {
      started: true,
      env: call.env,
      snapshot: call.snapshot
    };
  }

  if (message.command === 'service') {
    const adapter = await resolvedAdapter(fixture);

    fixture.control.hold = deferred();
    fixture.control.entered = deferred();
    running = adapter.runUntrusted({
      config: fixture.config,
      model: 'fixture-model',
      message: 'Служебный вызов'
    });

    const call = await fixture.control.entered.promise;

    return { started: true, env: call.env };
  }

  if (message.command === 'finish') {
    fixture.control.hold.resolve();
    await running;

    return { finished: true };
  }

  if (message.command === 'activate') {
    const response = await fixture.app.inject({
      method: 'POST',
      url: `${base()}/${message.profileId}/activate`,
      payload: {
        operationId: message.operationId,
        expectedRevision: message.revision,
      },
    });

    return { status: response.statusCode, body: response.json() };
  }

  if (message.command === 'usage') {
    return fixture.request('GET', '/api/providers/usage');
  }

  if (message.command === 'restart') {
    await fixture.restart();

    return { restarted: true };
  }

  if (message.command === 'submit') {
    const url = `${base()}/attempts/${message.attempt.id}/steps/${message.attempt.step.id}`;

    return fixture.request('POST', url, {
      operationId: message.operationId,
      expectedRevision: message.attempt.revision,
      input: message.input,
    });
  }

  if (message.command === 'factory-launch' || message.command === 'factory-http-launch') {
    process.env.PATH = `${fixture.root}/bin:/usr/bin:/bin`;

    let result;

    if (message.command === 'factory-http-launch') {
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/api/tasks/7/launch',
        payload: {
          profile: 'demo',
          route: 'feature',
          runnerPrimary: 'deepseek',
          title: 'Профиль доступа конвейера',
          description: 'Снимок выбран до запуска и сохраняется на воротах.',
          sourceUrl: 'https://example.test/tasks/7',
          acceptanceCriteria: [],
        },
      });

      result = { status: response.statusCode, body: response.json() };

      if (response.statusCode !== 200) {
        return { result };
      }
    } else {
      result = await spawnRouteEngine({
        ...fixture.config,
        accessProfiles: fixture.app.accessProfiles,
      }, {
        task: '7',
        args: message.args,
        accessProviderIds: ['deepseek'],
      });
    }

    const capture = await eventually(
      () => fs.readFile(path.join(fixture.root, 'factory-capture.json'), 'utf8')
        .then((text) => JSON.parse(text), () => null),
      Boolean,
    );

    factoryChildren.add(capture.pid);
    cleanups.push(async () => {
      if (!factoryChildren.has(capture.pid)) {
        return;
      }

      try {
        process.kill(capture.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }
    });

    return { result, capture };
  }

  if (message.command === 'factory-pause') {
    const capture = JSON.parse(await fs.readFile(path.join(fixture.root, 'factory-capture.json'), 'utf8'));

    process.kill(capture.pid, 'SIGTERM');
    factoryChildren.delete(capture.pid);
    await fs.rm(path.join(fixture.root, 'factory-capture.json'));

    return { paused: true };
  }

  throw new Error(`Неизвестная команда worker: ${message.command}`);
}

process.on('message', async (message) => {
  try {
    process.send({ id: message.id, ...await dispatch(message) });
  } catch (error) {
    process.send({ id: message.id, error: error.message });
  }
});

process.on('SIGTERM', async () => {
  fixture?.control.hold?.resolve();

  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }

  process.exit(0);
});
