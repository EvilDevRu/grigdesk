import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import codex from '../../../server/src/lib/executors/codex.ts';
import chatModule from '../../../server/src/modules/chat/index.ts';
import providersModule from '../../../server/src/modules/providers/index.ts';
import { PrefsStore } from '../../../server/src/lib/prefsStore.ts';
import { hostFixture } from './host-fixture.mjs';
import { hostManager } from './host-manager.mjs';

const requireServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');

/**
 * Настоящие chat/providers маршруты, prefs и история работают с настоящим Codex adapter.
 * Подменены только CLI, OS-manager и каталог моделей; владелец не отдаёт свои данные тесту.
 */
export async function hostApi(t, {
  fixture, host = false, liveEnabled = true, executor = codex, processManager = null,
  seed = false, modelId = 'fixture-model',
} = {}) {
  const f = fixture || await hostFixture(t);
  const manager = processManager || await hostManager(t, f.root, f.cleanup);
  const prefsPath = path.join(f.root, 'prefs.json');
  const prefs = new PrefsStore({ prefsPath });
  const home = path.join(f.root, 'home');
  const events = [];
  const handles = [];
  const app = Fastify({ logger: false });
  const config = {
    ...f.config,
    chatsDir: path.join(f.root, 'chats'),
    chatStoreLegacyPath: path.join(f.root, 'legacy.json'),
    chatBindingsDir: path.join(f.root, 'bindings'),
    modelsPath: path.join(f.root, 'models.json'),
    factoryHome: f.root,
    port: 18150,
  };
  const adapter = {
    ...executor,
    probe: async () => ({
      ok: true,
      version: '0.167.1',
    }),
    auth: async () => ({
      mode: 'cli',
      label: 'Синтетическая установка',
      available: true,
    }),
    seedModels: () => [{
      id: modelId,
      efforts: ['high'],
    }],
    modes: async () => [
      {
        id: 'auto',
        label: 'Авто',
      },
      {
        id: 'dontAsk',
        label: 'Не спрашивать',
      },
    ],
    commands: async () => [],
    session: {
      ...executor.session,
      async open(input) {
        const handle = await executor.session.open({
          ...input,
          env: {
            ...process.env,
            HOME: home,
            CODEX_HOME: home,
          },
          tokenInfoReader: async () => null,
        });

        handles.push(handle);

        return handle;
      },
    },
  };

  await mkdir(home, { recursive: true });

  if (!fixture || seed) {
    prefs.write({
      chatAutoCompactWindow: 0,
      chatLiveSessions: liveEnabled,
      providerSettings: {
        codex: {
          allowHostAccess: host,
          blockDirectSsh: false,
        }
      },
    });
  }

  app.decorate('sse', {
    broadcast(event, data) {
      events.push({
        event,
        data,
      });
    },
  });
  await app.register(chatModule, {
    config,
    prefs,
    modelsRegistry: async () => ({
      codex: [{
        id: modelId,
        efforts: ['high'],
      }]
    }),
    executorResolver: async (provider) => provider === 'codex' ? adapter : null,
    taskExists: async () => false,
    factoryState: {
      readEnv: async () => ({
        REPO_COUNT: '1',
        REPO_0_NAME: 'fixture',
        REPO_0_SOURCE: f.cwd,
        REPO_0_WT: f.cwd,
        REPO_0_BRANCH: 'fixture',
        WORKSPACE_MODE: 'shared',
      }),
    },
  });
  await app.register(providersModule, {
    config,
    prefs,
    claudeAuth: null,
    getProviderAdapters: async () => new Map([['codex', adapter]]),
    getModelsRegistry: async () => ({
      codex: [{
        id: modelId,
        efforts: ['high'],
      }]
    }),
  });
  await app.ready();
  f.cleanup(async () => {
    await manager.heal();
    await f.update({ hold: false });
    await app.close();
  });

  return {
    ...f,
    app,
    manager,
    prefs,
    prefsPath,
    events,
    handles,
    async chat(id = 'host-chat') {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/chat/store/chat',
        payload: {
          chat: {
            id,
            title: 'Тест Codex Host',
            model: modelId,
            modelRef: {
              provider: 'codex',
              model: modelId,
            },
            mode: 'auto',
            effort: 'high',
            messages: [{
              role: 'user',
              text: 'Сохранённая переписка',
              id: 'old-message',
            }],
            createdAt: 1,
            updatedAt: 1,
          }
        },
      });

      assert.equal(response.statusCode, 200, response.body);

      return id;
    },
    turn(chatKey = 'host-chat', extra = {}) {
      return app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: {
          chatKey,
          modelRef: {
            provider: 'codex',
            model: modelId,
          },
          model: modelId,
          effort: 'high',
          mode: 'auto',
          message: 'Выполни тестовый ход',
          ...extra,
        },
      });
    },
    toggle(value) {
      return app.inject({
        method: 'POST',
        url: '/api/providers/codex/settings',
        payload: {
          settingId: 'allowHostAccess',
          value,
          ...(value ? { confirmed: true } : {}),
        },
      });
    },
    async sessions() {
      return (await app.inject('/api/chat/sessions')).json();
    },
    async history(id = 'host-chat') {
      return (await app.inject(`/api/chat/store/chat/${id}`)).json().chat;
    },
  };
}
