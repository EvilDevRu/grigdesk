import { selectUiOption } from './helpers/selectUiOption.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  capabilities, loopDraft, roleCatalog, seedDraft, serverFixture,
} from '../fixtures/routes-stage-wizard.mjs';
import { clientBrowser } from './helpers/client-browser.mjs';

/**
 * Браузер получает синтетический API поверх одноразового server fixture.
 * Настоящие PATCH/validate/preview/simulation исполняют проектный код без живых данных.
 */
async function fixture(t, initial) {
  const { app } = await serverFixture(t);
  const draft = initial ?? await seedDraft();
  const source = await app.inject({
    method: 'PUT',
    url: '/api/routes/sample/editor/source',
    payload: {
      mode: 'editor',
      expectedSourceRevision: 0,
      expectedCatalogHash: null,
    },
  });

  assert.equal(source.statusCode, 200, source.body);

  const created = await app.inject({
    method: 'POST',
    url: '/api/routes/sample/drafts',
    payload: {
      kind: 'document',
      title: 'Мастер этапа',
      baseCatalogHash: null,
      baseSourceRevision: source.json().source.revision,
      document: {
        routes: draft.routes,
        bootstrap: draft.bootstrap,
        bootstrapPrompts: draft.bootstrapPrompts,
        presentation: draft.presentation,
        provenance: draft.provenance,
      },
    },
  });

  assert.equal(created.statusCode, 201, created.body);

  const catalog = await roleCatalog();
  const client = await clientBrowser(t, {
    shell: null,
    artifacts: path.join(process.env.GRIGDESK_ARTIFACTS_DIR, 'stage-wizard'),
    responses: { '/api/profiles': { profiles: ['sample'] } },
  });
  const calls = [];

  /**
   * Каждый viewport начинает с одного и того же содержимого и своей страницы.
   * Ошибки страницы и все связанные запросы доступны утверждениям сценария.
   */
  async function open(width, height, language = 'ru') {
    const page = await client.browser.newPage({
      viewport: { width, height },
      hasTouch: width < 500,
      isMobile: width < 500,
    });
    const errors = [];

    page.setDefaultTimeout(7000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((locale) => localStorage.setItem('grigdesk-ui-language', locale), language);
    await page.route('**/api/routes/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const payload = request.postData() ? request.postDataJSON() : undefined;

      calls.push({
        method,
        url: url.pathname,
        payload,
      });

      if (url.pathname.endsWith('/editor/stage-roles')) {
        await route.fulfill({ json: catalog });

        return;
      }

      const response = await app.inject({
        method,
        url: url.pathname + url.search,
        ...(payload === undefined ? {} : { payload }),
      });
      const json = response.json();

      if (url.pathname.endsWith('/editor')) {
        json.capabilities = capabilities;
        json.capabilitiesHash = 'b'.repeat(64);
      }

      await route.fulfill({ status: response.statusCode, json });
    });

    const initialNode = draft.routes.feature.route.nodes.find((node) => node.id === 'build')?.id
      ?? draft.routes.feature.route.entry;

    await page.goto(`${client.origin}#/routes?profile=sample&draft=${created.json().id}`
      + `&route=feature&node=${encodeURIComponent(initialNode)}&tab=graph`);
    await page.locator('[data-test="stage-add"]').waitFor({ state: 'attached' });

    if (width <= 1000) {
      await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
    }

    await page.locator('.route-stage-list__manage > summary').click();

    return { page, errors };
  }

  return {
    ...client,
    app,
    draft: created.json(),
    calls,
    open,
  };
}

/**
 * Три шага проходят через настоящий UI; Apply остаётся отдельным действием.
 * Проверка диалога до поиска карточек даёт исходный RED по отсутствию мастера.
 */
async function choose(page, role, after = 'build') {
  await page.locator('[data-test="stage-add"]').click();
  await page.getByRole('dialog').waitFor({ timeout: 2000 }).catch(() => {});
  assert.equal(await page.getByRole('dialog').count(), 1, 'Добавить этап открывает мастер');
  await page.locator(`[data-test="wizard-role-${role}"]`).click();
  await page.locator('[data-test="wizard-next"]').click();
  await page.locator('[data-test="wizard-next"]').click();
  await selectUiOption(page, page.locator('button[data-test="wizard-after"]'), after);
}

/**
 * Измеряет телепортированный диалог, а не скрываемую панель основного редактора.
 * Проверяются горизонтальные границы и достижимость кнопки после выбора на touch.
 */
async function assertGeometry(page, action) {
  const box = await page.getByRole('dialog').boundingBox();
  const viewport = page.viewportSize();

  assert.ok(box && box.x >= -1 && box.x + box.width <= viewport.width + 1);
  await page.locator(`[data-test="${action}"]`).scrollIntoViewIfNeeded();
  assert.equal(await page.locator(`[data-test="${action}"]`).isVisible(), true);
  assert.equal(await page.getByRole('dialog').evaluate((element) =>
    element.scrollWidth <= element.clientWidth + 1), true);
}

test('SW-E1: полный мастер desktop/touch', async (t) => {
  for (const [width, height] of [[1280, 800], [390, 844], [320, 640]]) {
    await t.test(`${width}`, async (sub) => {
      const client = await fixture(sub);
      const { page, errors } = await client.open(width, height);
      const before = structuredClone(client.draft.routes);

      await choose(page, 'review');
      await assertGeometry(page, 'wizard-apply');
      await page.locator('[data-test="wizard-apply"]').click();
      await assertGeometry(page, 'wizard-add-more');

      const reviewNode = before.small.route.nodes.find((node) => node.id === 'review');
      const context = Object.fromEntries(reviewNode.prompt.requiredContext.map((section) =>
        [section, { synthetic: true }]));

      await page.getByRole('dialog').locator('[data-test="preview-context"]').fill(JSON.stringify(context));
      await page.getByRole('dialog').locator('[data-test="preview-run"]').click();
      await page.getByRole('dialog').locator('.route-prompt-preview pre').waitFor();

      const reviewText = before.small.prompts['prompts/review.md'];
      const rendered = await page.getByRole('dialog').locator('.route-prompt-preview pre').textContent();

      assert.ok(rendered.includes(reviewText.trim()), 'Предпросмотр содержит инструкцию образца');
      assert.ok(await page.locator('.edge-related').count() > 0);

      const selectedId = new URL(page.url()).hash.match(/node=([^&]+)/)?.[1];
      const saved = await client.app.inject({
        method: 'GET', url: `/api/routes/sample/drafts/${client.draft.id}`,
      });
      const route = saved.json().routes.feature.route;

      assert.deepEqual(route.nodes.find((node) => node.id === 'build').on.done, { next: selectedId });
      assert.deepEqual(route.nodes.find((node) => node.id === selectedId).on.done, { next: 'verify' });
      await selectUiOption(page, page.getByRole('dialog')
        .locator('button[data-test="simulation-start-target"]'), 'feature');
      await page.getByRole('dialog').locator('[data-test="simulation-start"]').click();

      for (const nodeId of ['plan', 'skeptic', 'gate_plan', 'tests', 'build']) {
        const dialog = page.getByRole('dialog');

        assert.ok((await dialog.locator('.route-simulation').textContent()).includes(nodeId));
        await selectUiOption(page, dialog.locator('button[data-test="simulation-outcome"]'),
          nodeId === 'gate_plan' ? 'approved' : 'done');

        const stepped = page.waitForResponse((response) => response.url().includes('/simulate/step'));

        await dialog.locator('[data-test="simulation-step"]').click();

        const response = await stepped;
        const result = await response.json();

        assert.equal(result.ok, true, JSON.stringify(result.issues));
        await dialog.locator('.route-simulation strong').filter({ hasText: result.cursor.nodeId }).waitFor();
      }

      const simulationText = await page.getByRole('dialog').locator('.route-simulation').textContent();

      assert.ok(simulationText.includes(selectedId));
      await page.screenshot({ path: path.join(client.artifacts, `wizard-${width}.png`) });
      await page.locator('[data-test="wizard-add-more"]').click();
      await page.locator('[data-test="wizard-cancel"]').click();
      await page.getByRole('button', { name: 'Отменить', exact: true }).click();

      const validated = page.waitForResponse((response) => response.url().endsWith('/validate'));

      await page.getByRole('button', { name: 'Проверить черновик', exact: true }).click();
      await validated;

      const undone = await client.app.inject({
        method: 'GET', url: `/api/routes/sample/drafts/${client.draft.id}`,
      });

      assert.deepEqual(undone.json().routes, before);
      await page.getByRole('button', { name: 'Повторить', exact: true }).click();

      if (width <= 1000) {
        await page.getByRole('tab', { name: 'Маршрут', exact: true }).click();
      }

      await choose(page, 'human');
      await page.locator('[data-test="wizard-apply"]').click();
      await page.locator('[data-test="wizard-check-publish"]').click();
      await page.locator('[data-test="open-publish"]:enabled').waitFor();
      assert.equal(client.calls.some((call) => call.url.endsWith('/publish')), false);
      assert.equal(client.calls.some((call) => call.url.endsWith('/source')), false);
      await page.locator('[data-test="open-publish"]').click();
      assert.equal(await page.getByRole('dialog').count(), 1, 'Обычное подтверждение публикации');
      assert.equal(client.calls.some((call) => call.url.endsWith('/publish')), false);
      assert.deepEqual(errors, []);
      await page.close();
    });
  }
});

test('SW-E2: английский мастер и запреты', async (t) => {
  const client = await fixture(t);
  const { page, errors } = await client.open(390, 844, 'en');

  await page.locator('[data-test="stage-add"]').click();
  await page.getByRole('dialog').waitFor({ timeout: 2000 }).catch(() => {});
  assert.equal(await page.getByRole('dialog').count(), 1, 'Мастер доступен в английском интерфейсе');
  assert.match(await page.getByRole('dialog').textContent(), /Review|Tests before|Custom/);
  assert.equal(await page.locator('[data-test="wizard-role-browser"]').isDisabled(), true);
  assert.match(await page.getByRole('dialog').textContent(), /already|duplicate/i);
  await page.locator('[data-test="wizard-role-human"]').click();
  await page.locator('[data-test="wizard-next"]').click();
  await page.locator('[data-test="wizard-next"]').click();
  assert.equal(await page.locator('[data-test="wizard-after"] option[value="ship"]')
    .evaluate((element) => element.disabled), true);
  assert.match(await page.getByRole('dialog').textContent(), /delivery|ship|finish/i);
  await assertGeometry(page, 'wizard-apply');
  assert.deepEqual(errors, []);
  await page.close();

  await t.test('loop', async (sub) => {
    const loop = loopDraft(await seedDraft({ minimal: true }));
    const isolated = await fixture(sub, loop);
    const opened = await isolated.open(320, 640, 'en');

    await choose(opened.page, 'human', 'lead');
    assert.equal(await opened.page.locator('[data-test="wizard-after"] option[value="worker"]')
      .evaluate((element) => element.disabled), true);
    assert.match(await opened.page.getByRole('dialog').textContent(), /loop|worker|lead/i);
    assert.equal(await opened.page.locator('[data-test="wizard-after"] option[value="lead"]')
      .evaluate((element) => element.disabled), false);
    assert.deepEqual(opened.errors, []);
    await opened.page.close();
  });
});
