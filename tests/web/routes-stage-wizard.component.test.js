import assert from 'node:assert/strict';
import test from 'node:test';

import { capabilities } from '../fixtures/routes-stage-wizard.mjs';
import {
  chooseRole, click, content, deferred, field, openWizard, wizardFixture,
} from './helpers/routes-stage-wizard.mjs';

const dialogSelector = '[role="dialog"]';
const roleTitles = {
  review: 'Ревью',
  tests: 'Тесты до кода',
  browser: 'Проверка в браузере',
  human: 'Спросить меня',
  command: 'Проверка командой — линтер и тесты',
  custom: 'Своё — опишу словами',
};

/**
 * Проверяет отсутствие незаметных записей и истории при редактировании намерения.
 * Исходный снимок содержит все маршруты и инструкции, а не только выбранный узел.
 */
function assertUnchanged(fixture, before, generation, history) {
  assert.deepEqual(content(fixture.store.localDocument), before);
  assert.equal(fixture.store.editGeneration, generation);
  assert.equal(fixture.store.historyPast.length, history);
  assert.equal(fixture.calls.filter((call) => call.method === 'PATCH').length, 0);
}

test('SW-W1: Add открывает роли без изменения документа', async (t) => {
  const f = await wizardFixture(t);
  const before = content(f.store.localDocument);
  const generation = f.store.editGeneration;
  const history = f.store.historyPast.length;
  const dialog = await openWizard(f);

  for (const role of ['review', 'tests', 'browser', 'human', 'command', 'custom']) {
    const card = dialog.querySelector(`[data-test="wizard-role-${role}"]`);

    assert.equal(Boolean(card), true, role);
    assert.ok(card.textContent.includes(roleTitles[role]), `Название роли ${role}`);
    assert.ok(card.textContent.replace(roleTitles[role], '').trim().length > 12,
      'Помимо названия у карточки есть пояснение');
  }

  for (const role of ['tests', 'browser', 'command']) {
    const card = dialog.querySelector(`[data-test="wizard-role-${role}"]`);

    assert.equal(Boolean(card.disabled || card.getAttribute('aria-disabled') === 'true'), true);
    assert.match(card.parentElement.textContent, /уже|повтор|добавлен/i);
  }

  await click(f, '[data-test="wizard-role-review"]');
  await click(f, '[data-test="wizard-next"]');
  assert.equal(dialog.querySelector('[data-test="wizard-filesystem"]').value, 'workspace-write');
  assert.equal(dialog.querySelector('[data-test="wizard-failure"]').value, 'self-fix');
  await click(f, '[data-test="wizard-back"]');
  await click(f, '[data-test="wizard-cancel"]');
  assertUnchanged(f, before, generation, history);

  const noCommands = await wizardFixture(t, { capabilities: { ...capabilities, commands: [] } });
  const withoutCommands = await openWizard(noCommands);

  assert.equal(Boolean(withoutCommands.querySelector('[data-test="wizard-role-command"]')), false);
});

test('SW-W2: место одинаково выбирается схемой и списком', async (t) => {
  const f = await wizardFixture(t);

  await chooseRole(f, 'custom');

  const dialog = f.browser.document.querySelector(dialogSelector);
  const after = dialog.querySelector('[data-test="wizard-after"]');
  const ship = [...after.options].find((option) => option.value === 'ship');

  assert.equal(Boolean(ship?.disabled), true);
  assert.match(dialog.textContent, /сдач|заверш|после/i);
  await click(f, '[role="dialog"] [data-node="gate_accept"]');
  assert.equal(after.value, 'gate_accept');
  await field(f, '[data-test="wizard-after"]', 'build');
  assert.equal(dialog.querySelector('[data-node="build"]').getAttribute('aria-current'), 'true');
  await click(f, '[data-test="wizard-back"]');
  assert.equal(dialog.querySelector('[data-test="wizard-description"]').value,
    'Проверь результат.\nСохрани отчёт.');
  await click(f, '[data-test="wizard-next"]');
  assert.equal(dialog.querySelector('[data-test="wizard-after"]').value, 'build');

  const history = f.store.historyPast.length;

  await click(f, '[data-test="wizard-apply"]');
  assert.equal(f.store.historyPast.length, history + 1);
});

test('SW-W3: пустой путь и Insert прежние', async (t) => {
  const f = await wizardFixture(t);

  await openWizard(f);
  await click(f, '[data-test="wizard-empty"]');

  const empty = f.store.localDocument.routes.feature.route.nodes.find((node) => node.id === 'agent');

  assert.equal(empty?.executor, 'agent');
  assert.deepEqual(JSON.parse(JSON.stringify(empty.on)), {
    done: null,
    skipped: null,
    failed: null,
    exhausted: null,
  });
  assert.equal(f.store.localDocument.routes.feature.prompts['prompts/agent.base.md'], '');

  await f.wrapper.get('.route-stage-list').trigger('keydown', { key: 'Insert' });
  await f.flushPromises();
  assert.equal(f.store.localDocument.routes.feature.route.nodes.some((node) => node.id === 'agent_2'), true);

  const before = content(f.store.localDocument);
  const input = f.browser.document.createElement('textarea');

  f.wrapper.get('.route-stage-list').element.append(input);
  input.dispatchEvent(new f.browser.KeyboardEvent('keydown', { key: 'Insert', bubbles: true }));
  assert.deepEqual(content(f.store.localDocument), before);
  await f.wrapper.get('[data-test="stage-new-type"]').setValue('status');
  await f.wrapper.get('[data-test="stage-owner"]').setValue('build');
  await openWizard(f);
  await click(f, '[data-test="wizard-empty"]');
  assert.equal(f.store.localDocument.routes.feature.route.nodes.some((node) =>
    node.executor === 'status' && node.owner === 'build'), true);
});

test('SW-W4: вставка подсвечена и целиком отменяется', async (t) => {
  const f = await wizardFixture(t, { minimal: true });
  const before = content(f.store.localDocument);
  const history = f.store.historyPast.length;

  await chooseRole(f);
  await click(f, '[data-test="wizard-apply"]');

  const after = content(f.store.localDocument);
  const selected = f.route.query.node;

  assert.equal(f.store.historyPast.length, history + 1, 'Review и recheck — один шаг истории');
  assert.equal(after.routes.feature.route.nodes.length, before.routes.feature.route.nodes.length + 2);
  assert.equal(f.browser.document.querySelector(`[data-node="${selected}"]`)
    .classList.contains('selected'), true);
  assert.ok(f.browser.document.querySelectorAll('.edge-related').length > 0, 'Без hover');
  f.wrapper.vm.undoDraft();
  await f.flushPromises();
  assert.deepEqual(content(f.store.localDocument), before);
  f.wrapper.vm.redoDraft();
  await f.flushPromises();
  assert.deepEqual(content(f.store.localDocument), after);
});

test('SW-W5: язык и смена адресата безопасны', async (t) => {
  const f = await wizardFixture(t);

  await openWizard(f);
  await click(f, '[data-test="wizard-role-custom"]');
  await click(f, '[data-test="wizard-next"]');
  await field(f, '[data-test="wizard-description"]', 'Мой текст\nне теряется');
  f.setLocale('en');
  await f.flushPromises();

  const dialog = f.browser.document.querySelector(dialogSelector);

  assert.match(dialog.textContent, /Next|Back|Cancel/);
  assert.equal(dialog.querySelector('[data-test="wizard-description"]').value, 'Мой текст\nне теряется');
  f.setLocale('ru');
  await f.flushPromises();
  assert.match(dialog.textContent, /Далее|Назад|Отмена/);

  for (const key of ['profile', 'route', 'draft', 'readonly', 'late']) {
    await t.test(key, async (sub) => {
      const gate = deferred();
      const current = await wizardFixture(sub, key === 'late' ? { catalogGate: gate.promise } : {});
      const before = content(current.store.localDocument);

      await openWizard(current);

      if (key === 'readonly') {
        current.store.opened.readOnly = true;
      } else if (key === 'late') {
        current.route.query = { ...current.route.query, route: 'small' };
        gate.resolve();
      } else {
        current.route.query = { ...current.route.query, [key]: key === 'route' ? 'small' : 'other' };
      }

      await current.flushPromises();

      const apply = current.browser.document.querySelector('[data-test="wizard-apply"]');

      if (apply && !apply.disabled) {
        apply.click();
        await current.flushPromises();
      }

      assert.equal(current.calls.filter((call) => call.method === 'PATCH').length, 0);

      if (current.store.localDocument?.id === current.draft.id) {
        assert.deepEqual(content(current.store.localDocument), before);
      }
    });
  }

  for (const [label, error] of [['404', Object.assign(new Error('HTTP 404'), { status: 404 })],
    ['network', new TypeError('Failed to fetch')]]) {
    await t.test(label, async (sub) => {
      const failed = await wizardFixture(sub, { catalogError: error });
      const before = content(failed.store.localDocument);
      const generation = failed.store.editGeneration;
      const history = failed.store.historyPast.length;
      const errorDialog = await openWizard(failed);
      const ru = errorDialog.textContent;

      assert.match(ru, /не удалось|ошибк|недоступ/i);
      failed.setLocale('en');
      await failed.flushPromises();
      assert.match(errorDialog.textContent, /unavailable|failed|could not|error/i);
      assert.notEqual(errorDialog.textContent, ru);
      assertUnchanged(failed, before, generation, history);
      await click(failed, '[data-test="wizard-empty"]');
      assert.equal(failed.store.historyPast.length, history + 1);
      assert.equal(failed.store.localDocument.routes.feature.prompts['prompts/agent.base.md'], '');
    });
  }
});

test('SW-W6: новый этап работает с обычными preview и simulation', async (t) => {
  const f = await wizardFixture(t);

  await chooseRole(f, 'custom');
  await click(f, '[data-test="wizard-back"]');
  await field(f, '[data-test="wizard-failure"]', 'return');
  await field(f, '[data-test="wizard-return-target"]', 'build');
  await click(f, '[data-test="wizard-next"]');
  await click(f, '[data-test="wizard-apply"]');

  const insertedId = f.route.query.node;
  const inserted = f.store.localDocument.routes.feature.route.nodes.find((node) => node.id === insertedId);
  const context = Object.fromEntries(inserted.prompt.requiredContext.map((section) =>
    [section, { synthetic: true }]));

  await field(f, '[role="dialog"] [data-test="preview-context"]', JSON.stringify(context));
  await click(f, '[role="dialog"] [data-test="preview-run"]');

  assert.equal(f.store.dirty, false, 'Перед пробой завершён save');
  assert.equal(f.store.promptPreview?.stale, false);
  assert.match(f.store.promptPreview.result.text, /Проверь результат/);
  assert.equal(f.store.promptPreview.draftRevision, f.store.serverSnapshot.revision);
  await field(f, '[role="dialog"] [data-test="simulation-start-target"]', 'feature');
  await click(f, '[role="dialog"] [data-test="simulation-start"]');

  for (let index = 0; index < 20 && f.store.simulation.cursor.nodeId !== insertedId; index += 1) {
    const node = f.store.serverSnapshot.routes.feature.route.nodes.find((item) =>
      item.id === f.store.simulation.cursor.nodeId);

    await field(f, '[role="dialog"] [data-test="simulation-outcome"]',
      node.executor === 'gate' ? 'approved' : 'done');
    await click(f, '[role="dialog"] [data-test="simulation-step"]');
  }

  assert.equal(f.store.simulation.cursor.nodeId, insertedId);
  await field(f, '[role="dialog"] [data-test="simulation-outcome"]', 'failed');
  await field(f, '[role="dialog"] [data-test="simulation-failure-owner"]', 'build');
  await click(f, '[role="dialog"] [data-test="simulation-step"]');
  assert.equal(f.store.simulation.cursor.nodeId, 'build');
  assert.deepEqual([...f.store.simulation.last.reset], ['build', insertedId]);

  for (const failure of ['conflict', 'write']) {
    await t.test(failure, async (sub) => {
      const failed = await wizardFixture(sub);

      await chooseRole(failed, 'custom');
      failed.pending.patchError = Object.assign(new Error('Запись не выполнена'), {
        status: failure === 'conflict' ? 409 : 500,
      });
      await click(failed, '[data-test="wizard-apply"]');
      await click(failed, '[role="dialog"] [data-test="preview-run"]');
      assert.equal(failed.calls.some((call) => call.url.endsWith('/preview')), false);
      assert.equal(failed.store.promptPreview === null || failed.store.promptPreview.stale, true);
      assert.equal(Boolean(failed.browser.document.querySelector(dialogSelector)), true);
    });
  }

  const human = await wizardFixture(t);

  await chooseRole(human, 'human');
  await click(human, '[data-test="wizard-apply"]');
  assert.equal(Boolean(human.browser.document.querySelector(
    '[role="dialog"] [data-test="preview-run"]:not(:disabled)')), false);
});

test('SW-W7: финал только готовит обычную публикацию', async (t) => {
  const f = await wizardFixture(t);

  await chooseRole(f);
  await click(f, '[data-test="wizard-apply"]');

  const inserted = content(f.store.localDocument);

  await click(f, '[data-test="wizard-add-more"]');
  assert.deepEqual(content(f.store.localDocument), inserted);
  await click(f, '[data-test="wizard-role-human"]');
  await click(f, '[data-test="wizard-next"]');
  await click(f, '[data-test="wizard-next"]');
  await field(f, '[data-test="wizard-after"]', 'build');
  await click(f, '[data-test="wizard-apply"]');
  await click(f, '[data-test="wizard-check-publish"]');

  const endpoints = f.calls.filter((call) => /\/(validate|compare|publish|source)$/.test(call.url));

  assert.deepEqual(endpoints.map((call) => call.url.split('/').at(-1)), ['validate', 'compare']);
  assert.equal(f.wrapper.find('[data-test="open-publish"]').exists(), true);
  assert.equal(f.store.canConfirmPublish, true);
  assert.equal(Boolean(f.browser.document.querySelector(dialogSelector)), false);

  for (const scenario of ['issues', 'edit', 'draft', 'double']) {
    await t.test(scenario, async (sub) => {
      const current = await wizardFixture(sub);

      await chooseRole(current, 'human');
      await click(current, '[data-test="wizard-apply"]');

      const gate = deferred();

      current.pending.validateGate = gate.promise;

      if (scenario === 'issues') {
        current.pending.validationIssues = [{
          code: 'prompt_required',
          severity: 'error',
          scope: 'route',
          routeId: 'feature',
          nodeId: 'build',
          path: '/routes/feature',
          message: 'Инструкция отсутствует',
        }];
      }

      await click(current, '[data-test="wizard-check-publish"]');

      if (scenario === 'edit') {
        current.wrapper.vm.applyLocalChange((draft) => {
          draft.title = 'Новая правка';
        });
      } else if (scenario === 'draft') {
        current.route.query = { ...current.route.query, draft: '22222222-2222-4222-8222-222222222222' };
      } else if (scenario === 'double') {
        const button = current.browser.document.querySelector('[data-test="wizard-check-publish"]');

        button?.click();
      }

      gate.resolve();
      await current.flushPromises();
      assert.equal(current.calls.filter((call) => call.url.endsWith('/validate')).length, 1);
      assert.equal(current.calls.filter((call) => call.url.endsWith('/compare')).length,
        scenario === 'double' ? 1 : 0);
      assert.equal(current.calls.some((call) => /\/(publish|source)$/.test(call.url)), false);
    });
  }
});
