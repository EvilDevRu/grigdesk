import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { clientBrowser, scaleClientText } from './helpers/client-browser.mjs';
import { project, responses } from './fixtures/projects/data.mjs';

/**
 * Измеряем доступность содержимого и действий, а не только ширину документа:
 * overflow:hidden способен скрыть ошибку вёрстки внутри самой карточки.
 */
async function geometry(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.projects');
    const save = root.querySelector('[data-role="project-save"]');
    const saveRect = save?.getBoundingClientRect();
    const elements = [...root.querySelectorAll('*')];
    const overflow = elements.filter((element) => {
      const style = getComputedStyle(element);

      return element.clientWidth && element.scrollWidth > element.clientWidth + 2
        && style.overflowX === 'visible' && !['INPUT', 'TEXTAREA'].includes(element.tagName);
    }).map((element) => element.className);
    const targets = elements.filter((element) => (
      (element.tagName === 'BUTTON' || element.classList.contains('ui-radio'))
        && element.getBoundingClientRect().width > 0
    ));
    const labels = elements.filter((element) => (
      element.classList.contains('ui-button__label') && element.clientWidth > 0
        && element.scrollWidth > element.clientWidth + 2
    )).map((element) => element.textContent);

    return {
      overflow,
      labels,
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      // Действия шапки видимы на 32 px, а общий ::after сохраняет площадку touch 44 px.
      minimumTarget: Math.min(...targets.map((element) => {
        const height = element.getBoundingClientRect().height;
        const after = getComputedStyle(element, '::after');

        return after.content === 'none' ? height : Math.max(height, parseFloat(after.height) || 0);
      })),
      saveVisible: !saveRect || (saveRect.top >= 0 && saveRect.bottom <= innerHeight),
    };
  });
}

test('проекты: каталог, карточка и создание на телефоне, планшете и desktop', {
  timeout: 120000,
}, async (t) => {
  const { browser, origin, artifacts } = await clientBrowser(t, { responses });
  const matrix = [
    [320, 640, true, 1.3],
    [360, 740, true, 1],
    [390, 844, true, 1],
    [768, 1024, true, 1],
    [844, 390, true, 1],
    [1024, 768, true, 1],
    [1280, 800, false, 1],
    [1440, 1000, false, 1],
    [1920, 1080, false, 1],
    [2560, 1440, false, 1],
  ];

  for (const [width, height, hasTouch, zoom] of matrix) {
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch,
      reducedMotion: 'reduce',
    });

    try {
      for (const [state, route] of [
        ['catalog', '/projects'],
        ['detail', '/projects/atlas'],
        ['create', '/projects?create=1'],
      ]) {
        const page = await context.newPage();
        const errors = [];
        const label = `${width}x${height}-${state}`;

        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(origin + '#' + route);

        try {
          await page.locator(state === 'catalog'
            ? '[data-role="project-row"]' : '[data-role="project-title"]').first().waitFor();
        } catch (error) {
          await page.screenshot({ path: path.join(artifacts, `projects-failed-${label}.png`) });

          throw new Error(`Не открылся ${label}; ошибки страницы: ${JSON.stringify(errors)}`, {
            cause: error,
          });
        }

        await scaleClientText(page, zoom, '.projects');

        const result = await geometry(page);

        await page.screenshot({ path: path.join(artifacts, `projects-${label}.png`) });

        if (width === 1280 && state === 'detail') {
          const headers = await page.locator('.ui-pane-header').evaluateAll((nodes) => nodes.map((node) => (
            node.getBoundingClientRect().height
          )));

          assert.deepEqual(headers, [36, 36], 'Обе панели имеют общую desktop-геометрию шапки');
        }

        assert.equal(result.documentOverflow, false, label);
        assert.deepEqual(result.overflow, [], label);
        assert.deepEqual(result.labels, [], `Обрезанные подписи: ${label}`);
        assert.equal(result.saveVisible, true, `Недоступно сохранение: ${label}`);
        assert.ok(result.minimumTarget >= (hasTouch ? 44 : 28), label);
        assert.deepEqual(errors, [], label);
        await page.close();
      }
    } finally {
      await context.close();
    }
  }
});

test('проекты: клавиатура, сохранение, длинные данные и узкая рабочая область', {
  timeout: 60000,
}, async (t) => {
  const longProject = {
    ...project,
    title: 'Проект с длинным названием для проверки переноса в карточке и каталоге',
    routes: ['long-route-'.repeat(15)],
    repos: project.repos.map((repo) => ({ ...repo, dir: '/srv/' + 'workspace-'.repeat(40) })),
  };
  const { browser, origin } = await clientBrowser(t, {
    responses: { ...responses, '/api/projects/atlas': longProject },
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let saved = null;

  await page.route('**/api/projects/atlas', async (route) => {
    if (route.request().method() === 'PUT') {
      saved = route.request().postDataJSON();
      await route.fulfill({ json: {
        ...longProject,
        ...saved,
        repos: saved.repos.map((repo) => ({ ...repo, exists: true })),
        revision: 4,
      } });

      return;
    }

    await route.continue();
  });
  await page.goto(origin + '#/projects/atlas');
  await page.locator('[data-role="project-title"]').waitFor();
  await page.locator('.projects').evaluate((element) => {
    element.style.width = '600px';
  });
  await page.locator('[data-role="project-back"]').waitFor();
  assert.equal(await page.locator('[data-role="project-list"]').isVisible(), false);
  assert.deepEqual((await geometry(page)).overflow, []);

  const title = page.locator('[data-role="project-title"]');

  await title.fill('Обновлённый проект');
  await Promise.all([
    page.waitForResponse((response) => (
      response.url().endsWith('/api/projects/atlas') && response.request().method() === 'PUT'
    )),
    title.press('Enter'),
  ]);
  assert.equal(saved?.title, 'Обновлённый проект');
  await page.waitForFunction(() => document.querySelector('[data-role="project-save"]')?.disabled);
  await page.locator('[data-role="project-back"]').click();
  await page.locator('[data-role="project-search"] input').fill('Атлас');
  await page.locator('[data-role="project-row"]').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-role="project-title"]').waitFor();
  await page.locator('[data-role="project-back"]').click();
  assert.equal(await page.locator('[data-role="project-search"] input').inputValue(), 'Атлас');
});

test('проекты: конфликт сохранения и архив на узком экране с крупным текстом', {
  timeout: 60000,
}, async (t) => {
  const { browser, origin, artifacts } = await clientBrowser(t, { responses });
  const page = await browser.newPage({ viewport: { width: 320, height: 740 }, hasTouch: true });

  await page.route('**/api/projects/atlas', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ status: 409, json: {
        error: 'revision_conflict',
        message: 'Проект изменён в другом окне.',
        currentRevision: 4,
      } });

      return;
    }

    await route.continue();
  });
  await page.goto(origin + '#/projects/atlas');
  await page.locator('[data-role="project-title"]').fill('Мои изменения');
  await page.locator('[data-role="project-save"]').click();
  await page.locator('[data-role="project-conflict"]').waitFor();
  await scaleClientText(page, 1.3, '.projects');

  assert.deepEqual((await geometry(page)).labels, [], 'Подписи выбора версии читаются полностью');
  assert.equal(await page.locator('[data-role="project-title"]').inputValue(), 'Мои изменения');
  assert.equal(await page.locator('[data-role="project-detail-retry"]').count(), 0);
  await page.locator('.editor-scroll').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(artifacts, 'projects-conflict-phone.png') });

  const archive = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });

  await archive.goto(origin + '#/projects/archive');
  await archive.locator('[data-role="project-restore"]').waitFor();
  await archive.locator('.editor-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  assert.deepEqual((await geometry(archive)).overflow, []);
  await archive.screenshot({ path: path.join(artifacts, 'projects-archive-phone.png') });
});
