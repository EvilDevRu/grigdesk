import assert from 'node:assert/strict';

import { mountBoardView } from './board-view.js';
import { webFile } from './compile-vue.js';
import { CUSTOM_CAPS, STOCK_CAPS } from './trackerCard.js';
import { installedRecord, installJob } from '../../server/helpers/pluginInstallState.js';

export const trackerCatalog = () => ({
  revision: 1,
  activeIds: ['own'],
  externalId: null,
  drivers: [
    {
      id: 'own',
      name: 'GrigDesk',
      status: 'active',
      capabilities: { create: true, projects: true }
    },
    {
      id: 'b24-stock',
      name: 'Облачный Б24',
      status: 'available',
      capabilities: STOCK_CAPS,
      schema: {
        baseUrl: { type: 'string', label: 'Адрес портала' },
        accessToken: {
          type: 'string',
          secret: true,
          label: 'Токен доступа'
        },
      },
    },
    {
      id: 'b24-custom',
      name: 'Кастомный Б24',
      status: 'available',
      capabilities: CUSTOM_CAPS
    },
  ],
});

/**
 * Версии различаются digest и коммитом, чтобы откат нельзя было подтвердить кандидатом.
 * Поля снимка совпадают с InstallInfo, который читает общий строгий decoder.
 */
function driverInstallInfo(version, revision, previous = null) {
  return {
    ...installedRecord(version, revision),
    source: { kind: 'git', url: 'https://git.fixture/driver.git' },
    sha: (version === '1.0.0' ? 'a' : 'c').repeat(40),
    payloadDigest: (version === '1.0.0' ? 'b' : 'e').repeat(64),
    previous,
    updateAvailable: false,
    localChanges: false,
    restartRequired: true,
    rollbackAvailable: previous !== null,
    rollbackError: null,
  };
}

/**
 * Подготовка и terminal outcome используют согласованные target, preview и время завершения.
 * Смена версии не маскируется одним прежним ready-снимком для всех действий.
 */
function driverJob(kind, record, status = 'ready', previous = null) {
  const job = installJob(status, kind);
  const target = {
    version: record.version,
    tag: record.tag,
    sha: record.sha,
  };

  job.driverId = 'b24-custom';
  delete job.pluginId;
  job.source = record.source;
  job.target = target;
  Object.assign(job.preview, {
    id: job.driverId,
    name: 'Кастомный Б24',
    source: record.source,
    target,
    version: record.version,
    payloadDigest: record.payloadDigest,
    replaces: previous ? {
      kind: 'managed',
      version: previous.version,
      sourceChanged: false,
    }
      : { kind: 'none' },
  });

  return job;
}

/**
 * Доска и новые диалоги остаются настоящими, подменяется только HTTP.
 * Журнал различает driver и plugin API, а deferred response позволяет проверить double click.
 */
export async function mountTrackerBoard(t, {
  configured = false,
  handlers = {},
  catalog = trackerCatalog(),
} = {}) {
  const calls = [];
  const state = {
    catalog,
    settings: {
      revision: 1,
      externalId: null,
      settings: {}
    },
    job: null,
    installed: null,
  };
  const api = {
    /**
     * Читает синтетические данные того же API, что использует product store.
     * Сохранённая job переживает закрытие и повторное открытие диалога.
     */
    async get(url) {
      calls.push({ method: 'GET', url });

      if (handlers.get) {
        const result = await handlers.get(url, state);

        if (result !== undefined) {
          return result;
        }
      }

      if (url === '/api/trackers') {
        return structuredClone(state.catalog);
      }

      if (url === '/api/trackers/settings') {
        return structuredClone(state.settings);
      }

      if (url.includes('/driver-installs/jobs/')) {
        return { job: structuredClone(state.job) };
      }

      if (url === '/api/grigdesk-tasks/projects') {
        return { projects: [] };
      }

      return {
        tasks: [],
        revision: 0,
        b24Configured: configured
      };
    },
    /**
     * Мутации сохраняют серверный снимок и полный журнал входов.
     * Hook может удержать эффект или вернуть ошибку без подмены UI-логики.
     */
    async post(url, payload) {
      calls.push({
        method: 'POST',
        url,
        payload: structuredClone(payload)
      });

      if (handlers.post) {
        const result = await handlers.post(url, payload, state);

        if (result !== undefined) {
          return result;
        }
      }

      if (url === '/api/trackers/settings') {
        Object.assign(state.settings, payload, { revision: state.settings.revision + 1 });
        state.catalog.externalId = payload.externalId;
        state.catalog.activeIds = ['own', ...[payload.externalId].filter(Boolean)];
        state.catalog.revision = state.settings.revision;

        return structuredClone(state.settings);
      }

      if (url.endsWith('/versions')) {
        return {
          source: { kind: 'git', url: payload.url },
          versions: [{
            version: '1.0.0',
            tag: 'v1.0.0',
            sha: 'a'.repeat(40)
          }],
        };
      }

      if (url === '/api/driver-installs/jobs' || url.endsWith('/update')) {
        const kind = url.endsWith('/update') ? 'update' : 'install';
        const record = driverInstallInfo(kind === 'update' ? '1.1.0' : '1.0.0', 1);

        state.job = driverJob(kind, record, 'ready', state.installed);

        return { job: structuredClone(state.job) };
      }

      if (url.endsWith('/apply')) {
        assert.equal(state.job.status, 'ready');
        assert.equal(payload.reviewToken, state.job.reviewToken);

        state.installed = driverInstallInfo(state.job.target.version,
          (state.installed?.revision ?? 0) + 1, state.installed);
        state.job.status = 'done';
        state.job.finishedAt = '2026-01-01T00:00:01.000Z';
        state.job.updatedAt = state.job.finishedAt;
        state.job.revision += 1;

        return { job: structuredClone(state.job) };
      }

      if (url === '/api/driver-installs/check') {
        return { drivers: { 'b24-custom': structuredClone(state.installed) } };
      }

      if (url.endsWith('/rollback')) {
        assert.ok(state.installed?.previous, 'Откат требует опубликованного обновления');
        assert.equal(payload.expectedRevision, state.installed.revision);
        assert.equal(payload.expectedPreviousDigest, state.installed.previous.payloadDigest);

        const previous = state.installed;

        state.installed = driverInstallInfo(previous.previous.version, previous.revision + 1);
        state.job = driverJob('rollback', state.installed, 'done', previous);

        return { job: structuredClone(state.job) };
      }

      return {};
    },
  };
  const apiStub = `
    export const api = {
      get: (...args) => globalThis.__boardViewOwnApi.get(...args),
      post: (...args) => globalThis.__boardViewOwnApi.post(...args),
    };
    export { ApiError, failureText } from ${JSON.stringify(webFile('src/shared/apiClient.ts'))};
  `;
  const mounted = await mountBoardView(t, {
    ownApi: api,
    snapshot: {
      trackerId: 'b24-custom',
      capabilities: CUSTOM_CAPS,
      widgets: []
    },
    compilerStubs: {
      '../shared/apiClient.ts': apiStub,
      '../../shared/apiClient.ts': apiStub,
    },
  });

  return {
    ...mounted,
    apiCalls: calls,
    state,
    handlers
  };
}

/**
 * Кнопка ищется по доступному пользовательскому имени, а не по имени будущего компонента.
 * На базе её отсутствие даёт точный RED UI-функции, без ошибки импорта нового файла.
 */
export async function openTrackerSettings(card) {
  const button = card.wrapper.findAll('button').find((candidate) =>
    /настрой.*(доск|трекер)|трекер.*настрой|board settings|tracker settings/iu.test(
      `${candidate.text()} ${candidate.attributes('aria-label') ?? ''}`,
    ));

  assert.ok(button, 'На доске есть настройки трекера, даже без Б24');
  await button.trigger('click');
  await card.flushPromises();
}

export const actionButton = (wrapper, pattern) => wrapper.findAll('button')
  .find((button) => pattern.test(`${button.text()} ${button.attributes('aria-label') ?? ''}`));

/**
 * Общие controls допускают radio или select для единственного внешнего источника.
 * Тест выбирает реальное поле по его значению и проверяет эффект через HTTP.
 */
export async function chooseExternal(card, id) {
  const radio = card.wrapper.find(`input[type="radio"][value="${id}"]`);

  if (radio.exists()) {
    await radio.setValue(true);
  } else {
    const select = card.wrapper.findAll('select')
      .find((candidate) => candidate.find(`option[value="${id}"]`).exists());

    assert.ok(select, `Можно выбрать ${id}`);
    await select.setValue(id);
  }

  await card.flushPromises();
}
