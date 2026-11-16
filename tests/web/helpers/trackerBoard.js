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
      id: 'grigdesk-b24',
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
      id: 'grigdesk-b24-discript',
      name: 'Кастомный Б24',
      status: 'available',
      capabilities: CUSTOM_CAPS
    },
  ],
});

export const driverSourceCatalog = () => ({
  sources: [
    { title: 'Битрикс24', url: 'https://github.com/EvilDevRu/grigdesk-b24' },
    { title: 'Jira', url: 'https://github.com/EvilDevRu/grigdesk-jira' },
  ],
});

/**
 * Версии различаются digest и коммитом, чтобы откат нельзя было подтвердить кандидатом.
 * Поля снимка совпадают с InstallInfo, который читает общий строгий decoder.
 */
export function driverInstallInfo(version, revision, previous = null, extra = {}) {
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
    ...extra,
  };
}

/**
 * Подготовка и terminal outcome используют согласованные target, preview и время завершения.
 * Смена версии не маскируется одним прежним ready-снимком для всех действий.
 */
export function driverJob(kind, record, status = 'ready', previous = null) {
  const job = installJob(status, kind);
  const target = {
    version: record.version,
    tag: record.tag,
    sha: record.sha,
  };

  job.driverId = 'grigdesk-b24-discript';
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
  compilerStubs = {},
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
    trackerConfigured: configured,
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

      if (url === '/api/trackers/sources') {
        return driverSourceCatalog();
      }

      if (url === '/api/trackers/settings') {
        return structuredClone(state.settings);
      }

      if (url === '/api/driver-installs/installed') {
        return { drivers: { 'grigdesk-b24-discript': structuredClone(state.installed) } };
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
        trackerConfigured: state.trackerConfigured
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
        state.catalog.externalId = payload.default ?? payload.externalId ?? null;
        state.catalog.activeIds = ['own', ...(payload.drivers
          ?? [state.catalog.externalId].filter(Boolean))];

        if (payload.drivers) {
          state.catalog.enabledIds = [...payload.drivers];
          state.catalog.default = payload.default;
          state.settings.externalId = payload.default;
        }

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

      if (url.endsWith('/cancel')) {
        state.job.status = 'cancelled';
        state.job.finishedAt = '2026-01-01T00:00:01.000Z';
        state.job.updatedAt = state.job.finishedAt;
        state.job.revision += 1;

        return { job: structuredClone(state.job) };
      }

      if (url === '/api/driver-installs/check') {
        return { drivers: { 'grigdesk-b24-discript': structuredClone(state.installed) } };
      }

      if (url.endsWith('/remove')) {
        const id = url.split('/').at(-2);
        const driver = state.catalog.drivers.find((entry) => entry.id === id);

        assert.ok(driver);
        driver.deleted = true;
        driver.status = 'restartRequired';

        if (state.catalog.externalId === id) {
          state.catalog.externalId = null;
          state.catalog.activeIds = ['own'];
          state.catalog.revision += 1;
          state.settings.externalId = null;
          state.settings.revision = state.catalog.revision;
          state.trackerConfigured = false;
        }

        state.installed = null;
        state.job = null;

        for (const listener of globalThis.__boardViewOwnListeners ?? []) {
          listener('trackers-changed', { revision: state.catalog.revision });
        }

        return { id, restartRequired: true };
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
      trackerId: 'grigdesk-b24-discript',
      capabilities: CUSTOM_CAPS,
      widgets: [],
      tasks: [],
      toReview: [],
      created: [],
      accomplice: [],
      auditor: [],
    },
    compilerStubs: {
      '../shared/apiClient.ts': apiStub,
      '../../shared/apiClient.ts': apiStub,
      ...compilerStubs,
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
    /настро[йи].*(доск|трекер)|трекер.*настрой|board settings|tracker settings|set up tracker/iu.test(
      `${candidate.text()} ${candidate.attributes('aria-label') ?? ''}`,
    ));

  assert.ok(button, 'На доске есть настройки трекера, даже без Б24');
  await button.trigger('click');
  await card.flushPromises();
}

export const actionButton = (wrapper, pattern) => wrapper.findAll('button').find((button) => {
  const text = button.text().replace(/›$/u, '');

  return pattern.test(`${text} ${button.attributes('aria-label') ?? ''}`.trim());
});

/**
 * Действия пакета находятся прямо в параметрах выбранного драйвера.
 * Открытие настроек не восстанавливает старую операцию и не обращается к Git.
 */
export async function openTrackerDriverSettings(card) {
  await openTrackerSettings(card);
  await card.wrapper.get('[data-driver="grigdesk-b24-discript"]').trigger('click');
  await card.flushPromises();
}

/**
 * Общие controls допускают radio или select для единственного внешнего источника.
 * Тест выбирает реальное поле по его значению и проверяет эффект через HTTP.
 */
export async function chooseExternal(card, id) {
  if (!card.wrapper.find(`input[type="radio"][value="${id}"]`).exists()
    && !card.wrapper.findAll('select')
      .some((candidate) => candidate.find(`option[value="${id}"]`).exists())) {
    await actionButton(card.wrapper, /^(?:Подключение доски|Board connection)$/u).trigger('click');
    await card.flushPromises();
  }

  const radio = card.wrapper.find(`input[type="radio"][value="${id}"]`);

  if (radio.exists()) {
    await radio.setValue(true);
  } else {
    const select = card.wrapper.findAll('select')
      .find((candidate) => candidate.find(`option[value="${id}"]`).exists());

    assert.ok(select, `Можно выбрать ${id}`);
    await select.setValue(id);
  }

  const activation = card.wrapper.find('[data-role="tracker-board-enabled"]');

  if (activation.exists() && !activation.element.checked) {
    await activation.setValue(true);
  }

  await card.flushPromises();
}

/**
 * Установка начинается отдельным действием списка, сохраняя одну модальную оболочку.
 * Последующие действия обращаются к тому же диалогу, даже при смене шага.
 */
export async function openTrackerInstaller(card) {
  if (card.wrapper.find('[data-role="tracker-install"]').exists()) {
    return liveTrackerDialog(card);
  }

  const button = actionButton(card.wrapper, /^\s*(?:Добавить трекер|Add tracker|Установить|Install)\s*$/u);

  await button.trigger('click');
  await card.flushPromises();

  return liveTrackerDialog(card);
}

/**
 * UiDialog обновляет поверхность при смене доступного описания шага.
 * Проверки всегда обращаются к живому узлу вместо detached DOMWrapper прошлого шага.
 */
export function liveTrackerDialog(card) {
  return new Proxy({}, {
    get(_target, key) {
      const dialog = card.wrapper.find('[data-role="tracker-install"], [data-role="tracker-settings"]');
      const value = dialog[key];

      return typeof value === 'function' ? value.bind(dialog) : value;
    },
  });
}

/**
 * Общий путь ввода репозитория проходит выбор версии и явную проверку.
 * Подготовка не подтверждает применение и возвращает диалог для дальнейших проверок.
 */
export async function prepareTracker(card, url = 'https://git.fixture/driver.git') {
  const dialog = await openTrackerInstaller(card);

  await dialog.find('[data-role="driver-custom-source"]').trigger('click');
  await dialog.find('input[name="url"]').setValue(url);
  await actionButton(dialog, /^Далее$/u).trigger('click');
  await card.flushPromises();
  await actionButton(dialog, /^Проверить пакет$/u).trigger('click');
  await card.flushPromises();

  return dialog;
}
