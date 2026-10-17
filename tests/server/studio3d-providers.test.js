import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStudio3d } from '../../shared/studio3d/studio3dContracts.ts';
import { getProviderAdapters, isChatExecutor } from '../../server/src/lib/executors/index.ts';
import { createTripoAdapter } from '../../server/src/lib/executors/tripo.ts';
import { createLocalStudio } from '../../server/src/lib/studio3d/local.ts';
import { inputContext, offersFor, studioProviders } from '../../server/src/lib/studio3d/providers.ts';
import { RIG_V1 } from '../../server/src/lib/tripo/catalog.ts';
import { startFakeTripo, fakeTaskId } from './helpers/fakeTripo.js';

/**
 * Сводка входа содержит только синтетические metadata; offers не читает его bytes.
 * Реальный доступ к файлам проверит resolver под scope и lease перед запуском.
 */
function version(patch = {}) {
  return {
    kind: 'rigged',
    status: 'ready',
    provider: 'tripo',
    task: {
      provider: 'tripo',
      id: fakeTaskId(1),
      type: 'animate_rig'
    },
    params: { model: RIG_V1 },
    stats: { size: [1, 2, 1], bones: 3 },
    files: [{
      id: 'main',
      role: 'model',
      name: 'model.glb'
    }],
    mainFileId: 'main',
    views: [],
    rigCheck: null,
    accountKey: null,
    ...patch
  };
}

/**
 * Каталог обращается только к поддельному localhost API с отдельным env.
 * Native preflight и смена account происходят без живых ключей/заказов.
 */
async function fixture(t) {
  const fake = await startFakeTripo();
  const tripo = createTripoAdapter({ env: fake.env, fetchImpl: async (url, options) => {
    const rewritten = new URL(new URL(url).pathname, fake.baseUrl);

    return fetch(rewritten, options);
  } }).studio3d;

  fake.tasks.set(fakeTaskId(1), {
    task_id: fakeTaskId(1),
    type: 'animate_rig',
    status: 'success',
    output: {}
  });
  t.after(() => fake.close());

  return { fake, tripo };
}

test('PV-01 настоящий реестр имеет studio3d у Tripo, чатовый допуск остаётся закрыт', async () => {
  const adapters = await getProviderAdapters();

  assert.equal(adapters.get('tripo').studio3d.id, 'tripo');
  assert.equal(isChatExecutor(adapters.get('tripo')), false);
});

test('PV-02 узкие studio3d адаптеры затем local, универсальные и карточки без поля исключены', () => {
  const declared = {
    id: 'fixture',
    name: 'Исполнитель',
    local: false
  };
  const providers = studioProviders({
    adapters: new Map([
      ['fixture', {
        id: 'fixture',
        type: '3d',
        studio3d: declared
      }],
      ['chat', {
        id: 'chat',
        type: 'universal',
        studio3d: declared
      }],
      ['empty', { id: 'empty', type: '3d' }],
    ]),
    local: createLocalStudio()
  });

  assert.deepEqual(providers.map((provider) => provider.id), ['fixture', 'local']);
});

test('PV-03 старт объявляет создание с оценкой 30 и не предлагает local', async (t) => {
  const { tripo } = await fixture(t);
  const offers = await offersFor({
    providers: [tripo, createLocalStudio()],
    version: null,
    uploads: []
  });

  for (const operation of ['text-to-model', 'image-to-model', 'views-to-model',
    'image-to-splat', 'text-to-image']) {
    assert.equal(offers.some((offer) => offer.operation === operation), true);
  }

  assert.equal(offers.find((offer) => offer.operation === 'image-to-model').quote.total, 30);
  assert.equal(offers.some((offer) => offer.provider === 'local'), false);
  parseStudio3d.offers({ libraryId: '00000000-0000-4000-8000-000000000001', offers });
});

test('PV-04 Tripo rig допускает движения, файл и local helpers имеют честные причины', async (t) => {
  const { tripo } = await fixture(t);
  const source = version({ accountKey: tripo.snapshot().accountKey });
  const offers = await offersFor({ providers: [tripo, createLocalStudio()], version: source });
  const imported = await offersFor({
    providers: [tripo, createLocalStudio()],
    version: version({
      task: null,
      provider: null,
      params: null
    })
  });

  assert.equal(offers.find((offer) => offer.operation === 'animate').available, true);
  assert.match(imported.find((offer) => offer.operation === 'animate').reason,
    /Для этого шага нужна версия, где скелет, поставленный Tripo/);

  for (const operation of ['rotate', 'scale']) {
    const offer = imported.find((item) => item.operation === operation);

    assert.equal(offer.provider, 'local');
    assert.equal(offer.available, true);
    assert.equal(offer.quote.total, 0);
  }
});

test('PV-05 без ключа предложения видны с переходом в настройки, сети нет', async () => {
  let requests = 0;
  const provider = createTripoAdapter({ env: {}, fetchImpl: async () => {
    requests += 1;

    throw new Error('нельзя обращаться в сеть');
  } }).studio3d;
  const offers = await offersFor({ providers: [provider], version: null });

  assert.equal(offers.length > 0, true);
  assert.equal(offers.every((offer) => !offer.available), true);
  assert.match(offers[0].reason, /Нужен ключ Tripo/);
  assert.equal(requests, 0);
});

test('PV-06 чужой/expired native не предлагается для native-only, файловый fallback доступен', async (t) => {
  const { fake, tripo } = await fixture(t);
  const source = version({ accountKey: tripo.snapshot().accountKey });

  fake.tasks.get(fakeTaskId(1)).status = 'expired';

  const expired = await offersFor({ providers: [tripo], version: source });
  const foreign = await offersFor({
    providers: [tripo],
    version: version({ accountKey: 'foreign-fixture' })
  });

  for (const offers of [expired, foreign]) {
    assert.equal(offers.find((offer) => offer.operation === 'animate').available, false);
    assert.equal(offers.find((offer) => offer.operation === 'export').available, true);
  }

  assert.equal(inputContext(version({ task: null, provider: 'local' }), tripo).nativeTaskType, null);
  assert.equal(fake.requests.filter((request) => request.method === 'POST'
    && !request.path.endsWith('/list')).length, 0);
});

test('PV-06 неизвестные rig params и animated bounds не дают выдуманные движения/рост', async (t) => {
  const { tripo } = await fixture(t);
  const source = version({
    accountKey: tripo.snapshot().accountKey,
    params: null,
    stats: { bones: 3, size: null }
  });
  const offers = await offersFor({ providers: [tripo, createLocalStudio()], version: source });

  assert.equal(offers.find((offer) => offer.operation === 'animate').available, false);
  assert.equal(offers.find((offer) => offer.operation === 'scale').available, false);
});
