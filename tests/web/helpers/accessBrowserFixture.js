import assert from 'node:assert/strict';

import { i18nBrowser } from './i18nBrowser.js';

export const ACCESS_ROOT = '/api/providers/fixture/access-profiles';
export const PRIVATE_INPUT = 'synthetic-browser-private-access-code';
export const WARNING = 'Аккаунт не удалось определить; новый ключ может относиться к другому аккаунту';

/**
 * DTO сетевой фикстуры хранит только публичные поля; секрет остаётся в теле запроса.
 * Мутации имеют отдельный журнал, чтобы reload и потерянный ACK не скрыли второй POST.
 */
export function browserAccessState() {
  return {
    revision: 1,
    activeProfileId: 'profile-a',
    profiles: [
      {
        id: 'profile-a',
        name: 'Основной аккаунт',
        methodId: 'api-key',
        authState: 'ready',
        revision: 1
      },
      {
        id: 'profile-b',
        name: 'Запасной аккаунт',
        methodId: 'api-key',
        authState: 'ready',
        revision: 1
      },
    ],
    methods: [{
      id: 'api-key',
      kind: 'api-key',
      label: 'API',
      isolation: 'isolated',
      fields: [{
        id: 'apiKey',
        kind: 'secret',
        label: 'API-ключ'
      }],
    }],
  };
}

/**
 * Настоящий AppShell, настройки и мастер работают в двух браузерных контекстах.
 * Вместо поставщика и сервера используются локальные HTTP/SSE-порты одного теста.
 */
export async function accessBrowser(t, options = {}) {
  const snapshot = browserAccessState();
  const calls = [];
  const streams = new Set();
  const operations = new Map();
  const control = {
    listStatus: 200,
    busy: false,
    unauthorized: false,
    dropAck: false,
    connections: 0,
    attempt: null,
  };
  const broadcast = (event = 'providers-update') => {
    for (const stream of streams) {
      stream.write(`event: ${event}\ndata: ${JSON.stringify({
        accessProfiles: 'fixture', revision: snapshot.revision,
      })}\n\n`);
    }
  };
  const fixturePlugin = {
    name: 'access-profile-fixture',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, 'http://access-fixture');

        if (url.pathname === '/api/providers') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            providers: [{
              ...provider,
              accessProfiles: {
                ...provider.accessProfiles,
                activeProfile: snapshot.profiles.find((item) => item.id === snapshot.activeProfileId) ?? null,
              },
            }],
          }));

          return;
        }

        if (url.pathname === '/api/events') {
          control.connections += 1;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('event: hello\ndata: {"boot":"access-fixture"}\n\n');
          streams.add(response);
          response.on('close', () => streams.delete(response));

          return;
        }

        if (!url.pathname.startsWith(ACCESS_ROOT)) {
          next();

          return;
        }

        const chunks = [];

        for await (const chunk of request) {
          chunks.push(chunk);
        }

        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        const call = {
          path: url.pathname,
          method: request.method,
          body
        };

        calls.push(call);

        let result = snapshot;
        let status = 200;

        if (control.unauthorized) {
          status = 401;
          result = { error: 'auth_required' };
        } else if (request.method === 'GET' && url.pathname === ACCESS_ROOT) {
          status = control.listStatus;
          result = status === 200 ? { ...snapshot, switchAllowed: !control.busy }
            : { error: 'Временный отказ списка' };
        } else if (request.method === 'GET' && url.pathname.includes('/operations/')) {
          result = operations.get(url.pathname.split('/').at(-1));
        } else if (request.method === 'GET' && url.pathname.includes('/attempts')) {
          result = url.pathname.endsWith('/attempts') ? { attempts: [control.attempt].filter(Boolean) }
            : control.attempt;
        } else if (request.method === 'POST' && url.pathname.endsWith('/attempts')) {
          control.attempt ??= {
            id: 'attempt-one',
            revision: 1,
            state: 'running',
            profileId: body.profileId ?? 'profile-b',
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            step: {
              id: 'step-one',
              kind: 'enter-code',
              label: 'API-ключ'
            },
          };
          result = control.attempt;
        } else if (request.method === 'POST' && url.pathname.includes('/steps/')) {
          if (control.attempt.step.kind === 'choice') {
            control.attempt = {
              ...control.attempt,
              revision: control.attempt.revision + 1,
              state: 'saved',
              step: {
                id: 'result',
                kind: 'result',
                outcome: 'saved'
              },
            };
          } else {
            control.attempt = {
              ...control.attempt,
              revision: control.attempt.revision + 1,
              step: {
                id: 'confirm-account',
                kind: 'choice',
                reason: 'account_unknown',
                message: WARNING,
                choices: [
                  { id: 'confirm', label: 'Подтвердить замену' },
                  { id: 'cancel', label: 'Отмена' },
                ],
              },
            };
          }

          result = control.attempt;
        } else if (url.pathname.endsWith('/cancel')) {
          control.attempt = {
            ...control.attempt,
            state: 'cancelled',
            step: { kind: 'result', id: 'cancelled' }
          };
          result = control.attempt;
        } else if (url.pathname.endsWith('/activate')) {
          if (control.busy) {
            status = 409;
            result = { error: 'access_busy', message: 'Исполнитель ожидает подтверждения' };
          } else {
            snapshot.activeProfileId = url.pathname.split('/').at(-2);
            snapshot.revision += 1;
          }
        } else if (request.method === 'PATCH') {
          const profile = snapshot.profiles.find((item) => item.id === url.pathname.split('/').at(-1));

          profile.name = body.name;
          profile.revision += 1;
          result = { profile };
        } else if (request.method === 'DELETE') {
          snapshot.profiles = snapshot.profiles.filter((item) => item.id !== url.pathname.split('/').at(-1));
        }

        if (body?.operationId) {
          operations.set(body.operationId, { state: 'completed', result });
        }

        if (request.method !== 'GET' && status < 400) {
          broadcast();
        }

        if (control.dropAck && request.method !== 'GET') {
          control.dropAck = false;
          // Обрезанное тело теряет ACK после применения, не провоцируя повтор POST самим Chromium.
          // Клиент должен узнать исход через GET operation, сохранив единственный секретный запрос.
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end('{');

          return;
        }

        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
      });
    },
  };
  const provider = {
    id: 'fixture',
    name: 'Исполнитель фикстуры',
    type: 'universal',
    kind: 'cli',
    installed: true,
    available: true,
    chatEnabled: true,
    models: [],
    settings: [],
    credentials: [],
    accessProfiles: {
      supported: true,
      methods: snapshot.methods,
      activeProfile: snapshot.profiles[0]
    },
  };
  const result = await i18nBrowser(t, {
    vitePlugins: [fixturePlugin],
    responses: { '/api/providers': { providers: [provider], models: [] } },
  });
  const context = await result.browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  t.after(async () => {
    for (const stream of streams) {
      stream.end();
    }

    await context.close();
  });

  return {
    ...result,
    context,
    page,
    snapshot,
    control,
    calls,
    broadcast
  };
}

/**
 * Раздел выбирается штатным store; готовность страницы и списка подтверждает DOM.
 * Проверка кнопки выполняется после загрузки, сохраняя исходный RED отсутствующей возможности.
 */
export async function openProfiles(f, page = f.page) {
  await page.goto(`${f.origin}#/chats`);
  await page.getByRole('button', { name: /^(Настройки|Settings)$/u }).click();
  await page.locator('[data-role="settings-modal"]').waitFor();
  await page.evaluate(() => {
    document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      ._s.get('settings').selectPage('agents.providers', 'fixture', 'access');
  });

  const providerPage = page.locator('[data-provider-page="fixture"][data-ready="true"]');

  await providerPage.waitFor();
  await providerPage.getByText(/^(Загрузка(?: профилей)?|Loading(?: profiles)?)…$/u)
    .waitFor({ state: 'hidden' });

  const addButton = providerPage.getByRole('button', {
    name: /^(Добавить профиль|Add profile)$/u,
    includeHidden: true,
  });

  // Восстановленный мастер делает лежащую под ним готовую страницу inert.
  // Наличие списка проверяется и при открытом шаге, не закрывая восстановленную попытку.
  assert.equal(await addButton.count(), 1,
    'В настройках исполнителя доступен список и добавление профиля');
}

/**
 * Мастер открывается той же кнопкой, которой пользуется человек.
 * Отсутствующая возможность даёт assert по готовому экрану, а не ошибку импорта.
 */
export async function openWizard(f) {
  await openProfiles(f);
  await f.page.getByRole('button', { name: /^(Добавить профиль|Add profile)$/u }).click();
}
