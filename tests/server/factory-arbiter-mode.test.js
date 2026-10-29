import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveArbiterTarget } from '../../server/src/lib/factoryArbiter.ts';
import { resolveModelRef } from '../../server/src/lib/chat/modelRef.ts';
import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';

const modelRef = { provider: 'glm', model: '["zai","glm-5.3"]' };

/**
 * Проверяет настоящий resolver без каталога аккаунта и без обращения к модели.
 * Исполнитель задаётся тестом, ссылка разрешается общим кодом реестра.
 */
function resolveTarget(executor) {
  return resolveArbiterTarget({
    modelRef: { ...modelRef, effort: 'high' },
    modelsRegistry: async () => ({ glm: [{ id: modelRef.model }] }),
    executorResolver: async () => executor,
    resolveRef: resolveModelRef,
  });
}

test('арбитр принимает настоящий каталог GLM без plan и выбирает auto', async () => {
  const adapter = createGlmAdapter({ env: { GRIGDESK_GLM_API_MODE: 'api' } });
  const target = await resolveTarget(adapter);

  assert.equal(target.ok, true);
  assert.equal(target.permissionMode, 'auto');
  assert.equal(target.executor, adapter);
  assert.deepEqual(target.ref, modelRef);
  assert.equal(target.effort, 'high');
});

test('каталог с plan и auto всё равно запускает арбитра в auto', async () => {
  const target = await resolveTarget({
    run: async () => assert.fail('Проверка каталога не запускает модель'),
    modes: () => [{ id: 'plan' }, { id: 'auto' }],
  });

  assert.equal(target.ok, true);
  assert.equal(target.permissionMode, 'auto');
});

test('без подтверждённого auto арбитр отказывает без подмены режима', async (t) => {
  const catalogs = [
    ['только plan', () => [{ id: 'plan' }]],
    ['каталог отсутствует', undefined],
    ['каталог повреждён', () => ({ id: 'auto' })],
    ['чтение не удалось', async () => {
      throw new Error('Каталог недоступен');
    }],
  ];

  for (const [name, modes] of catalogs) {
    await t.test(name, async () => {
      const target = await resolveTarget({
        run: async () => assert.fail('Неподдержанный режим не запускает модель'),
        modes,
      });

      assert.deepEqual(target, {
        ok: false,
        error: 'arbiter_auto_unavailable',
        message: 'исполнитель арбитра не поддерживает режим «Авто»',
      });
    });
  }
});
