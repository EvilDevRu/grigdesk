import assert from 'node:assert/strict';
import test from 'node:test';

import {
  capabilities, insertRole, loopDraft, nodeAt, requireWizardCommands, roleCatalog, scope, seedDraft,
} from '../fixtures/routes-stage-wizard.mjs';
import { validateRoute } from '../../server/src/modules/routes/schema.ts';
import { compileModule, webFile } from './helpers/compile-vue.js';

const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));

/**
 * Проверяет runtime-схему, а не только список ошибок клиентской операции.
 * Полные promptFiles взяты из получившегося документа, чужие маршруты не исправляются.
 */
function assertValid(draft) {
  const entry = draft.routes.feature;

  assert.doesNotThrow(() => validateRoute(entry.route, {
    profile: 'sample',
    routeId: 'feature',
    promptFiles: Object.keys(entry.prompts),
  }));
}

/**
 * Невозможная вставка должна сохранить тот же снимок и объяснить отказ.
 * Одной блокировки карточки недостаточно: прямой вызов тоже защищает документ.
 */
function assertRefused(result, draft) {
  assert.deepEqual(result.draft, draft);
  assert.equal(result.createdNodeIds.length, 0);
  assert.ok(result.issues.some((issue) => typeof issue.message === 'string' && issue.message.length > 0));
}

test('SW-C1: defaults ролей и ответы меняют исполняемые поля', async () => {
  requireWizardCommands(commands);

  const catalog = await roleCatalog();
  const before = structuredClone(catalog);

  for (const role of catalog.roles) {
    const result = commands.prepareStageRole(
      role, { ...role.defaults, description: 'Проверь контракт' }, capabilities,
    );

    assert.deepEqual(result.issues, [], role.id);

    const node = result.nodes[0];

    if (role.id === 'human') {
      assert.equal(node.executor, 'gate');

      for (const field of ['prompt', 'policy', 'retry', 'fanout', 'requiredContext']) {
        assert.equal(Object.hasOwn(node, field), false, field);
      }

      continue;
    }

    assert.equal(node.retry.productFailure, 0, role.id);
    assert.deepEqual(node.fanout, {
      mode: 'single',
      maxExecutors: 1,
      degrade: 'forbid',
    });

    if (role.id === 'command') {
      assert.equal(node.executor, 'command');
      assert.equal(node.commandId, 'verify');
      assert.equal(node.policy.filesystem, 'state-only');
      assert.equal(node.policy.browser, 'forbid');
      assert.equal(Object.hasOwn(node, 'prompt'), false);
      assert.deepEqual(node.retry, {
        noResult: 0,
        productFailure: 0,
        providerFailure: { attempts: 0, strategy: 'none' },
      });

      continue;
    }

    assert.equal(node.policy.filesystem, role.defaults.filesystem);
    assert.equal(node.policy.browser, role.defaults.browser ? 'allow' : 'forbid');
    assert.equal(node.prompt.requiredContext.includes('services'), role.defaults.services);

    for (const section of role.node?.prompt?.requiredContext ?? []) {
      if (section !== 'services') {
        assert.ok(node.prompt.requiredContext.includes(section), section);
      }
    }

    for (const bytes of Object.values(role.prompts)) {
      assert.ok(Object.values(result.prompts).includes(bytes), `Точные bytes ${role.id}`);
    }

    const readOnly = commands.prepareStageRole(role, {
      ...role.defaults,
      filesystem: 'state-only',
      failure: 'ask',
      description: 'Проверь контракт',
      services: false,
      browser: false,
    }, capabilities);

    assert.deepEqual(readOnly.issues, []);
    assert.equal(readOnly.nodes[0].policy.filesystem, 'state-only');
    assert.equal(readOnly.nodes[0].policy.browser, 'forbid');
    assert.equal(readOnly.nodes[0].prompt.requiredContext.includes('services'), false);

    const browser = commands.prepareStageRole(role, {
      ...role.defaults,
      filesystem: 'workspace-write',
      failure: 'return',
      description: 'Проверь контракт',
      services: true,
      browser: true,
      returnTargetId: 'build',
    }, capabilities);

    assert.equal(browser.nodes[0].policy.browser, 'allow');
    assert.ok(browser.nodes[0].prompt.requiredContext.includes('services'));
    assert.ok(Object.values(browser.prompts).some((text) => text.includes('build')));
  }

  const review = catalog.roles.find((role) => role.id === 'review');
  const invalid = commands.prepareStageRole(review, {
    ...review.defaults,
    filesystem: 'state-only',
    failure: 'self-fix',
  }, capabilities);

  assert.ok(invalid.issues.length > 0, 'Самоправка несовместима с чтением');
  assert.deepEqual(catalog, before);
});

test('SW-C2: собственный текст становится инструкцией', async () => {
  requireWizardCommands(commands);

  const catalog = await roleCatalog();
  const role = catalog.roles.find((item) => item.id === 'custom');
  const description = 'Проверь контракт и оставь вывод.\n'.repeat(40) + '<script>данные</script>\n';
  const result = commands.prepareStageRole(role, { ...role.defaults, description }, capabilities);

  assert.deepEqual(result.issues, []);
  assert.ok(Object.values(result.prompts).includes(description), 'Текст сохранён побайтно отдельно');
  assert.ok((result.nodes[0].description ?? '').length <= 500);

  for (const text of ['', ' \n\t ']) {
    const invalid = commands.prepareStageRole(role, { ...role.defaults, description: text }, capabilities);

    assert.ok(invalid.issues.length > 0);
  }

  const decoder = await import('../../shared/pipeline/routeStageWizardContracts.ts');

  assert.equal(typeof decoder.parseStageRoleCatalog, 'function');
  assert.deepEqual(decoder.parseStageRoleCatalog(catalog), catalog);
  assert.throws(() => decoder.parseStageRoleCatalog({ ...catalog, secret: true }));
  assert.throws(() => decoder.parseStageRoleCatalog({
    ...catalog, roles: [{ ...role, id: 'unknown' }],
  }));
});

test('SW-I1: вставка сшивает done и все возвраты', async () => {
  const drafts = await Promise.all([seedDraft(), seedDraft()]);

  // Успешный переход обходит соседей, но skipped оставляет их достижимыми.
  // Проверяем оба входа до операции: вставка не должна чинить чужой невалидный маршрут.
  nodeAt(drafts[1], 'build').on.done = { next: 'audit' };
  nodeAt(drafts[1], 'build').on.skipped = { next: 'verify' };

  for (const draft of drafts) {
    assertValid(draft);
  }

  requireWizardCommands(commands);

  for (const draft of drafts) {

    const before = structuredClone(draft);
    const successor = nodeAt(draft, 'build').on.done;
    const result = await insertRole(commands, draft, 'custom', 'build', {
      description: 'Проверь результат',
      failure: 'return',
      returnTargetId: 'build',
    });
    const id = result.createdNodeIds[0];

    assert.deepEqual(result.issues, []);
    assert.deepEqual(nodeAt(result.draft, 'build').on.done, { next: id });
    assert.deepEqual(nodeAt(result.draft, id).on.done, successor);
    assert.deepEqual(nodeAt(result.draft, 'build').on.skipped, nodeAt(before, 'build').on.skipped);

    const order = [...result.draft.routes.feature.route.sequence.main, 'ship'];

    for (const node of result.draft.routes.feature.route.nodes) {
      for (const action of [...Object.values(node.on ?? {}), ...Object.values(node.onFailure ?? {})]) {
        if (action?.rewind) {
          const reset = order.slice(order.indexOf(action.rewind), order.indexOf(node.id) + 1);

          assert.deepEqual(action.reset, reset);
        }
      }
    }

    assert.deepEqual(nodeAt(result.draft, id).onFailure.build, { rewind: 'build', reset: ['build', id] });
    assert.deepEqual(nodeAt(result.draft, id).onFailure.human, { stop: 'human' });
    assert.deepEqual(nodeAt(result.draft, id).onFailure.environment, { stop: 'human' });
    assert.deepEqual(result.draft.routes.small, before.routes.small);
    assert.deepEqual(result.draft.routes.debug, before.routes.debug);
    assert.deepEqual(result.draft.bootstrap, before.bootstrap);

    for (const [file, bytes] of Object.entries(before.routes.feature.prompts)) {
      assert.equal(result.draft.routes.feature.prompts[file], bytes, file);
    }

    assert.deepEqual(draft, before);
    assertValid(result.draft);
  }
});

test('SW-I2: вставка после решения использует approved', async () => {
  requireWizardCommands(commands);

  const draft = await seedDraft({ minimal: true });
  const rejected = structuredClone(nodeAt(draft, 'gate_accept').on.rejected);
  const result = await insertRole(commands, draft, 'human', 'gate_accept');
  const id = result.createdNodeIds[0];

  assert.deepEqual(result.issues, []);
  assert.deepEqual(nodeAt(result.draft, 'gate_accept').on.approved, { next: id });
  assert.deepEqual(nodeAt(result.draft, 'gate_accept').on.rejected, rejected);
  assert.deepEqual(nodeAt(result.draft, id).on.approved, { next: 'ship' });
  assertValid(result.draft);

  const terminal = await seedDraft({ minimal: true });

  nodeAt(terminal, 'build').on.done = { stop: 'done' };

  const stopped = await insertRole(commands, terminal, 'custom', 'build', { description: 'Проверка' });

  assert.deepEqual(stopped.issues, []);
  assert.deepEqual(nodeAt(stopped.draft, stopped.createdNodeIds[0]).on.done, { stop: 'done' });
});

test('SW-I3: защищены сдача и пара цикла', async () => {
  requireWizardCommands(commands);

  const draft = loopDraft(await seedDraft({ minimal: true }));

  assertValid(draft);

  const catalog = await roleCatalog();
  const role = catalog.roles.find((item) => item.id === 'custom');
  const prepared = commands.prepareStageRole(
    role, { ...role.defaults, description: 'Проверка' }, capabilities,
  );
  const places = commands.listStageInsertionPlaces(draft, scope, prepared, capabilities);

  for (const afterId of ['ship', 'worker']) {
    const place = places.find((item) => item.afterId === afterId);

    assert.ok(place?.disabledReason, afterId);
    assertRefused(await insertRole(commands, draft, 'custom', afterId, { description: 'Проверка' }), draft);
  }

  const result = await insertRole(commands, draft, 'custom', 'lead', {
    description: 'Проверка',
    failure: 'return',
    returnTargetId: 'worker',
  });

  assert.deepEqual(result.issues, []);
  assert.equal(result.draft.routes.feature.route.entry, 'lead');
  assert.deepEqual(nodeAt(result.draft, 'worker'), nodeAt(draft, 'worker'));
  assert.deepEqual(nodeAt(result.draft, 'lead').on.failed, nodeAt(draft, 'lead').on.failed);
  assertValid(result.draft);
});

test('SW-I4: хостовая роль не дублируется', async () => {
  requireWizardCommands(commands);

  const draft = await seedDraft();

  for (const roleId of ['tests', 'browser', 'command']) {
    assertRefused(await insertRole(commands, draft, roleId, 'build'), draft);
  }

  for (const roleId of ['tests', 'browser', 'command']) {
    const occupied = await seedDraft({ minimal: true });

    const canonicalId = roleId === 'command' ? 'verify' : roleId;

    nodeAt(occupied, 'plan').id = canonicalId;
    occupied.routes.feature.route.entry = canonicalId;
    occupied.routes.feature.route.sequence.main[0] = canonicalId;

    assertRefused(await insertRole(commands, occupied, roleId, 'build'), occupied);
  }

  for (const roleId of ['review', 'custom', 'human']) {
    const first = await insertRole(commands, draft, roleId, 'build', { description: 'Проверка' });
    const second = await insertRole(
      commands, first.draft, roleId, 'build', { description: 'Другая проверка' },
    );

    assert.deepEqual(first.issues, []);
    assert.deepEqual(second.issues, []);
    assert.notEqual(first.createdNodeIds[0], second.createdNodeIds[0]);
    assertValid(second.draft);
  }
});

test('SW-I5: ревью всегда имеет перепроверку', async () => {
  requireWizardCommands(commands);

  const feature = await seedDraft();
  const result = await insertRole(commands, feature, 'review', 'build');
  const review = nodeAt(result.draft, result.createdNodeIds[0]);

  assert.deepEqual(result.issues, []);
  assert.equal(result.createdNodeIds.length, 1);
  assert.deepEqual(review.on.done, { next: 'verify' });
  assert.ok(review.prompt.blocks.some((block) => {
    const text = result.draft.routes.feature.prompts[block.file];

    return text.includes('RECHECK') && text.includes('verify') && text.includes('VERIFY');
  }), 'Отдельный блок явно привязывает RECHECK к verify/VERIFY');

  const minimal = await seedDraft({ minimal: true });
  const pair = await insertRole(commands, minimal, 'review', 'build');

  assert.deepEqual(pair.issues, []);
  assert.equal(pair.createdNodeIds.length, 2);
  assert.equal(nodeAt(pair.draft, 'recheck').commandId, 'recheck');
  assert.equal(nodeAt(pair.draft, 'recheck').runKey, 'RECHECK');
  assert.deepEqual(nodeAt(pair.draft, pair.createdNodeIds[0]).on.done, { next: 'recheck' });
  assertValid(pair.draft);

  const occupied = structuredClone(pair.draft);

  nodeAt(occupied, 'build').on.done = { next: 'gate_accept' };

  assertRefused(await insertRole(commands, occupied, 'review', 'build'), occupied);

  const catalog = await roleCatalog();
  const template = catalog.roles.find((role) => role.id === 'review');
  const unavailable = commands.prepareStageRole(
    template, template.defaults, { ...capabilities, commands: [] },
  );

  assert.ok(unavailable.issues.length > 0, 'Без объявленной перепроверки роль объясняет недоступность');
});
