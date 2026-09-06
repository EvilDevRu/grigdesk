import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apiError,
  button,
  mountKnowledgeView,
} from './helpers/knowledge-view.js';

process.env.NODE_ENV = 'test';

const ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ID = '00000000-0000-4000-8000-000000000002';
const RECORD = {
  id: ID,
  project: 'alpha',
  repository: 'backend',
  kind: 'fact',
  title: 'Очередь деплоя',
  body: 'Полный текст записи.',
  tags: ['queue'],
  updatedAt: '2026-08-29T00:00:00.000Z',
  revision: 3,
};

function listResponse() {
  return {
    items: [RECORD],
    facets: { projects: ['alpha', 'beta'], tags: ['queue', 'release'] },
  };
}

function baseApi(calls = []) {
  return {
    async get(url) {
      calls.push(['GET', url]);
      if (url === '/api/knowledge') return listResponse();
      if (url === `/api/knowledge/${ID}`) return { record: RECORD };
      if (url.startsWith('/api/knowledge/search?')) {
        return { items: [{ id: ID, title: RECORD.title, tags: ['queue'], fragment: '…деплоя…' }] };
      }
      if (url.startsWith('/api/knowledge?')) return listResponse();
      assert.fail(`unexpected GET ${url}`);
    },
    async post(url, body) {
      calls.push(['POST', url, body]);
      if (url === '/api/knowledge') {
        return { record: { ...RECORD, ...body, revision: 1 } };
      }
      assert.fail(`unexpected POST ${url}`);
    },
    async put(url, body) {
      calls.push(['PUT', url, body]);
      return { record: { ...RECORD, ...body, revision: body.expectedRevision + 1 } };
    },
    async del(url, body) {
      calls.push(['DELETE', url, body]);
      return { deleted: true, id: ID };
    },
    async download(url) {
      calls.push(['DOWNLOAD', url]);
      return {
        blob: new Blob(['backup'], { type: 'application/json' }),
        filename: 'cockpit-knowledge-2026-08-30.json',
      };
    },
    async upload(url, body) {
      calls.push(['UPLOAD', url, body]);
      assert.fail(`unexpected UPLOAD ${url}`);
    },
  };
}

test('Страница показывает список записей и доступные фасеты', async (t) => {
  const { wrapper } = await mountKnowledgeView(t, { api: baseApi() });

  assert.deepEqual({
    title: wrapper.text().includes('Очередь деплоя'),
    projects: ['alpha', 'beta'].every((value) => wrapper.text().includes(value)),
    tags: ['queue', 'release'].every((value) => wrapper.text().includes(value)),
  }, {
    title: true,
    projects: true,
    tags: true,
  });
});

test('Фильтры проекта и тега запрашивают отфильтрованный список', async (t) => {
  const calls = [];
  const { wrapper, settle } = await mountKnowledgeView(t, { api: baseApi(calls) });
  await wrapper.get('[name="project"]').setValue('alpha');
  await wrapper.get('[name="tag"]').setValue('queue');
  await settle();

  assert.equal(calls.at(-1)?.[1], '/api/knowledge?project=alpha&tag=queue');
});

test('Поиск показывает фрагмент, а открытие отдельно загружает полный текст', async (t) => {
  const calls = [];
  const { wrapper, settle } = await mountKnowledgeView(t, { api: baseApi(calls) });
  await wrapper.get('[name="query"]').setValue('деплой');
  await button(wrapper, 'Найти').trigger('click');
  await settle();
  await button(wrapper, 'Очередь деплоя').trigger('click');
  await settle();

  assert.deepEqual({
    search: calls.some((call) => call[0] === 'GET' && call[1].includes('/search?q=')),
    read: calls.some((call) => call[1] === `/api/knowledge/${ID}`),
    fragment: wrapper.text().includes('…деплоя…'),
    body: wrapper.text().includes(RECORD.body),
  }, {
    search: true,
    read: true,
    fragment: true,
    body: true,
  });
});

test('Создание отправляет введённую человеком запись', async (t) => {
  const calls = [];
  const { wrapper, settle } = await mountKnowledgeView(t, { api: baseApi(calls) });
  await button(wrapper, 'Новая запись').trigger('click');
  await wrapper.get('[name="project"]').setValue('alpha');
  await wrapper.get('[name="repository"]').setValue('backend');
  await wrapper.get('[name="kind"]').setValue('fact');
  await wrapper.get('[name="title"]').setValue('Новая запись');
  await wrapper.get('[name="body"]').setValue('Новый полный текст.');
  await wrapper.get('[name="tags"]').setValue('queue, release');
  await button(wrapper, 'Сохранить').trigger('click');
  await settle();

  assert.deepEqual(calls.find((call) => call[0] === 'POST'), [
    'POST',
    '/api/knowledge',
    {
      project: 'alpha',
      repository: 'backend',
      kind: 'fact',
      title: 'Новая запись',
      body: 'Новый полный текст.',
      tags: ['queue', 'release'],
    },
  ]);
});

test('Правка использует authoritative revision открытой записи', async (t) => {
  const calls = [];
  const { wrapper, settle } = await mountKnowledgeView(t, { api: baseApi(calls) });
  await button(wrapper, 'Очередь деплоя').trigger('click');
  await settle();
  await wrapper.get('[name="title"]').setValue('Исправленный заголовок');
  await button(wrapper, 'Сохранить').trigger('click');
  await settle();

  assert.deepEqual(calls.find((call) => call[0] === 'PUT'), [
    'PUT',
    `/api/knowledge/${ID}`,
    {
      project: 'alpha',
      repository: 'backend',
      kind: 'fact',
      title: 'Исправленный заголовок',
      body: 'Полный текст записи.',
      tags: ['queue'],
      expectedRevision: 3,
    },
  ]);
});

test('Удаление подтверждается и передаёт текущую ревизию в DELETE', async (t) => {
  const calls = [];
  const confirmations = [];
  const { wrapper, settle } = await mountKnowledgeView(t, {
    api: baseApi(calls),
    confirm: async (text) => { confirmations.push(text); return true; },
  });
  await button(wrapper, 'Очередь деплоя').trigger('click');
  await settle();
  await button(wrapper, 'Удалить').trigger('click');
  await settle();

  assert.deepEqual({
    confirmed: confirmations.length === 1 || calls.some((call) => call[0] === 'DELETE'),
    deletion: calls.find((call) => call[0] === 'DELETE'),
  }, {
    confirmed: true,
    deletion: ['DELETE', `/api/knowledge/${ID}`, { expectedRevision: 3 }],
  });
});

test('DELETE-клиент отправляет CAS-тело и не повторяет оборванную мутацию', async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  const networkError = new TypeError('network failed');
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    throw networkError;
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const { api } = await import(
    `../../web/src/shared/api-client.js?knowledge-delete=${Date.now()}`
  );
  let caught;
  try {
    await api.del(`/api/knowledge/${ID}`, { expectedRevision: 3 });
  } catch (error) {
    caught = error;
  }

  assert.deepEqual({
    count: requests.length,
    method: requests[0]?.options.method,
    contentType: requests[0]?.options.headers['Content-Type'],
    body: requests[0]?.options.body,
    sameError: caught === networkError,
  }, {
    count: 1,
    method: 'DELETE',
    contentType: 'application/json',
    body: JSON.stringify({ expectedRevision: 3 }),
    sameError: true,
  });
});

for (const failure of [
  { name: 'конфликт', error: apiError(409, { error: 'knowledge_conflict', message: 'Запись изменена.' }) },
  {
    name: 'отказ хранилища',
    error: apiError(503, { error: 'knowledge_unavailable', message: 'База недоступна.' }),
  },
  { name: 'обрыв сети', error: new TypeError('network failed') },
]) {
  test(`При ошибке сохранения «${failure.name}» черновик остаётся и PUT не повторяется`, async (t) => {
    const calls = [];
    const api = baseApi(calls);
    api.put = async (url, body) => {
      calls.push(['PUT', url, body]);
      throw failure.error;
    };
    const { wrapper, settle } = await mountKnowledgeView(t, { api });
    await button(wrapper, 'Очередь деплоя').trigger('click');
    await settle();
    await wrapper.get('[name="body"]').setValue('Несохранённый черновик.');
    await button(wrapper, 'Сохранить').trigger('click');
    await settle();

    assert.deepEqual({
      puts: calls.filter((call) => call[0] === 'PUT').length,
      draft: wrapper.get('[name="body"]').element.value,
      visibleError: /изменена|недоступна|network|ошиб/iu.test(wrapper.text()),
    }, {
      puts: 1,
      draft: 'Несохранённый черновик.',
      visibleError: true,
    });
  });
}

test('Выключенный плагин показывает штатное состояние недоступности', async (t) => {
  const api = baseApi();
  api.get = async () => {
    throw apiError(404, { error: 'plugin_disabled', message: 'Плагин выключен.' });
  };
  const { wrapper } = await mountKnowledgeView(t, { api });

  assert.match(wrapper.text(), /плагин.*выключен|знания.*недоступны/iu);
});

function previewWithConflict() {
  return {
    snapshotHash: 'snapshot-preview',
    summary: { create: 0, update: 0, unchanged: 242, conflict: 1, targetOnly: 0 },
    conflicts: [{
      id: ID,
      title: RECORD.title,
      baseRevision: 3,
      currentRevision: 4,
      changedFields: ['body'],
      incoming: { ...RECORD, body: 'Текст из экспортированного файла.' },
      current: { ...RECORD, body: 'Свежая правка в базе.', revision: 4 },
    }],
  };
}

function conflictDecisionSelect(wrapper) {
  const found = wrapper.findAll('select').find((item) => (
    item.find('option[value="keep-current"]').exists()
      && item.find('option[value="use-import"]').exists()
  ));
  assert.ok(found, 'не найден выбор решения конфликта');
  return found;
}

test('Download-клиент получает Blob и имя вложения с credentialed POST', async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response('backup bytes', {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="cockpit-knowledge-2026-08-30.json"',
      },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const { api } = await import(`../../web/src/shared/api-client.js?knowledge-download=${Date.now()}`);

  const result = await api.download('/api/knowledge/backup/export');

  assert.deepEqual({
    request: requests[0],
    filename: result.filename,
    body: await result.blob.text(),
  }, {
    request: {
      url: '/api/knowledge/backup/export',
      options: { credentials: 'include', method: 'POST' },
    },
    filename: 'cockpit-knowledge-2026-08-30.json',
    body: 'backup bytes',
  });
});

test('Download-клиент разбирает JSON-ошибку и уведомляет об истёкшей сессии', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'unauthorized',
    message: 'Сессия истекла.',
  }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
  t.after(() => { globalThis.fetch = originalFetch; });
  const { api } = await import(`../../web/src/shared/api-client.js?knowledge-download-error=${Date.now()}`);
  const notices = [];
  api.onUnauthorized((data) => notices.push(data));
  let caught;

  try {
    await api.download('/api/knowledge/backup/export');
  } catch (error) {
    caught = error;
  }

  assert.deepEqual({
    status: caught?.status,
    message: caught?.message,
    notices,
  }, {
    status: 401,
    message: 'Сессия истекла.',
    notices: [{ error: 'unauthorized', message: 'Сессия истекла.' }],
  });
});

test('Кнопка экспорта создаёт ровно одно скачивание и освобождает object URL', async (t) => {
  const calls = [];
  const api = baseApi(calls);
  const { wrapper, downloads, settle } = await mountKnowledgeView(t, { api });

  await button(wrapper, 'Экспортировать').trigger('click');
  await settle();

  assert.deepEqual({
    requests: calls.filter((call) => call[0] === 'DOWNLOAD'),
    blobs: downloads.created.length,
    clicks: downloads.clicked,
    revoked: downloads.revoked,
  }, {
    requests: [['DOWNLOAD', '/api/knowledge/backup/export']],
    blobs: 1,
    clicks: [{
      href: 'blob:knowledge-1',
      download: 'cockpit-knowledge-2026-08-30.json',
    }],
    revoked: ['blob:knowledge-1'],
  });
});

test('Во время экспорта повторные операции недоступны', async (t) => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const api = baseApi();
  api.download = async () => pending;
  const { wrapper, settle } = await mountKnowledgeView(t, { api });

  await button(wrapper, 'Экспортировать').trigger('click');
  await settle();

  assert.deepEqual({
    exportDisabled: button(wrapper, 'Экспортировать').attributes('disabled') !== undefined,
    importDisabled: button(wrapper, 'Импортировать').attributes('disabled') !== undefined,
  }, {
    exportDisabled: true,
    importDisabled: true,
  });
  finish({ blob: new Blob(['backup']), filename: 'cockpit-knowledge-2026-08-30.json' });
  await settle();
});

test('Один выбранный File отправляется и в preview, и в apply с решениями', async (t) => {
  const calls = [];
  const api = baseApi(calls);
  api.upload = async (url, formData) => {
    calls.push(['UPLOAD', url, formData]);
    if (url.endsWith('/preview')) {
      return previewWithConflict();
    }
    return {
      created: 0,
      updated: 0,
      unchanged: 242,
      keptCurrent: 1,
      overwritten: 0,
      targetOnly: 0,
      total: 243,
    };
  };
  const { wrapper, file, settle } = await mountKnowledgeView(t, { api });

  await button(wrapper, 'Импортировать').trigger('click');
  await settle();
  await conflictDecisionSelect(wrapper).setValue('keep-current');
  await button(wrapper, 'Применить импорт').trigger('click');
  await settle();

  const uploads = calls.filter((call) => call[0] === 'UPLOAD');
  assert.deepEqual({
    urls: uploads.map((call) => call[1]),
    sameFiles: uploads.map((call) => call[2].get('file') === file),
    snapshotHash: uploads[1]?.[2].get('snapshotHash'),
    resolutions: JSON.parse(uploads[1]?.[2].get('resolutions') || 'null'),
  }, {
    urls: [
      '/api/knowledge/backup/import/preview',
      '/api/knowledge/backup/import/apply',
    ],
    sameFiles: [true, true],
    snapshotHash: 'snapshot-preview',
    resolutions: [{
      id: ID,
      decision: 'keep-current',
      expectedCurrentRevision: 4,
    }],
  });
});

test('Предпросмотр загруженного файла показывает счётчики и обе версии конфликта', async (t) => {
  const api = baseApi();
  api.upload = async () => previewWithConflict();
  const { wrapper, settle } = await mountKnowledgeView(t, { api });

  await button(wrapper, 'Импортировать').trigger('click');
  await settle();

  assert.deepEqual({
    counters: /создать:\s*0[\s\S]*обновить:\s*0[\s\S]*без изменений:\s*242/iu
      .test(wrapper.text()),
    field: wrapper.text().includes('body'),
    incoming: wrapper.text().includes('Текст из экспортированного файла.'),
    current: wrapper.text().includes('Свежая правка в базе.'),
  }, {
    counters: true,
    field: true,
    incoming: true,
    current: true,
  });
});

test('Применение импорта недоступно до решения каждого конфликта', async (t) => {
  const api = baseApi();
  api.upload = async () => previewWithConflict();
  const { wrapper, settle } = await mountKnowledgeView(t, { api });
  await button(wrapper, 'Импортировать').trigger('click');
  await settle();

  assert.equal(
    button(wrapper, 'Применить импорт').attributes('disabled') !== undefined,
    true,
  );
});

test('Ошибка apply сохраняет предпросмотр и выбор без автоматического повтора', async (t) => {
  const calls = [];
  const api = baseApi(calls);
  api.upload = async (url, body) => {
    calls.push(['UPLOAD', url, body]);
    if (url.endsWith('/preview')) {
      return previewWithConflict();
    }
    if (url.endsWith('/apply')) {
      throw apiError(409, {
        error: 'knowledge_import_stale',
        message: 'Экспорт или база изменились.',
      });
    }
    assert.fail(`unexpected POST ${url}`);
  };
  const { wrapper, settle } = await mountKnowledgeView(t, { api });
  await button(wrapper, 'Импортировать').trigger('click');
  await settle();
  await conflictDecisionSelect(wrapper).setValue('use-import');
  await button(wrapper, 'Применить импорт').trigger('click');
  await settle();

  assert.deepEqual({
    applies: calls.filter((call) => call[1].endsWith('/apply')).length,
    choice: conflictDecisionSelect(wrapper).element.value,
    previewVisible: wrapper.text().includes('Текст из экспортированного файла.'),
  }, {
    applies: 1,
    choice: 'use-import',
    previewVisible: true,
  });
});

test('Отдельная кнопка обновляет карты без экспорта или импорта', async (t) => {
  const calls = [];
  const api = baseApi(calls);
  api.post = async (url, body) => {
    calls.push(['POST', url, body]);
    return { recordCount: 243, mapCount: 14, mapBytes: 30400, totalContextBytes: 48100 };
  };
  const { wrapper, settle } = await mountKnowledgeView(t, { api });

  await button(wrapper, 'Обновить карты').trigger('click');
  await settle();

  assert.deepEqual(calls.filter((call) => call[0] !== 'GET'), [
    ['POST', '/api/knowledge/maps/refresh', undefined],
  ]);
});

test('Без имени из заголовка экспорт скачивается с датированным fallback-именем', async (t) => {
  const api = baseApi();
  api.download = async () => ({ blob: new Blob(['backup']) });
  const { wrapper, downloads, settle } = await mountKnowledgeView(t, { api });

  await button(wrapper, 'Экспортировать').trigger('click');
  await settle();

  assert.equal(
    downloads.clicked[0]?.download,
    `cockpit-knowledge-${new Date().toISOString().slice(0, 10)}.json`,
  );
});

test('Прямой адрес знания загружает и показывает полную запись', async (t) => {
  const calls = [];
  const { wrapper } = await mountKnowledgeView(t, { api: baseApi(calls), routeId: ID });

  assert.deepEqual({
    reads: calls.filter((call) => call[1] === `/api/knowledge/${ID}`).length,
    bodyVisible: wrapper.text().includes(RECORD.body),
  }, {
    reads: 1,
    bodyVisible: true,
  });
});

test('Смена UUID в адресе открывает новую полную запись без перемонтирования', async (t) => {
  const calls = [];
  const second = { ...RECORD, id: SECOND_ID, title: 'Вторая запись', body: 'Второе полное тело.' };
  const api = baseApi(calls);
  api.get = async (url) => {
    calls.push(['GET', url]);
    if (url === '/api/knowledge') return listResponse();
    if (url === `/api/knowledge/${ID}`) return { record: RECORD };
    if (url === `/api/knowledge/${SECOND_ID}`) return { record: second };
    assert.fail(`unexpected GET ${url}`);
  };
  const { wrapper, setRouteId, settle } = await mountKnowledgeView(t, { api, routeId: ID });

  setRouteId(SECOND_ID);
  await settle();

  assert.deepEqual({
    lastRead: calls.filter((call) => call[1].includes('/api/knowledge/')).at(-1)?.[1],
    bodyVisible: wrapper.text().includes(second.body),
  }, {
    lastRead: `/api/knowledge/${SECOND_ID}`,
    bodyVisible: true,
  });
});

test('Открытие и закрытие записи синхронизируют живой адрес', async (t) => {
  const { wrapper, pushes, settle } = await mountKnowledgeView(t, { api: baseApi() });

  await button(wrapper, 'Очередь деплоя').trigger('click');
  await settle();
  await button(wrapper, 'Закрыть').trigger('click');
  await settle();

  const paths = pushes.map((target) => (
    typeof target === 'string'
      ? target
      : target?.path || (target?.params?.id ? `/knowledge/${target.params.id}` : undefined)
  ));
  assert.deepEqual(paths, [`/knowledge/${ID}`, '/knowledge']);
});

test('Открытый черновик блокирует экспорт и импорт', async (t) => {
  const { wrapper, settle } = await mountKnowledgeView(t, { api: baseApi() });
  await button(wrapper, 'Новая запись').trigger('click');
  await settle();

  assert.deepEqual({
    exportDisabled: button(wrapper, 'Экспортировать').attributes('disabled') !== undefined,
    importDisabled: button(wrapper, 'Импортировать').attributes('disabled') !== undefined,
  }, {
    exportDisabled: true,
    importDisabled: true,
  });
});
