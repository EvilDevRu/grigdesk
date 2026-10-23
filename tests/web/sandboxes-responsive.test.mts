import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Page } from '../../desktop/node_modules/playwright-core/index.js';
import type {
  SandboxEntry, SandboxJob, SandboxOverview,
} from '../../shared/plugins/sandboxes/sandboxContracts.ts';

import { clientBrowser } from './helpers/client-browser.mjs';

const baseEntry: SandboxEntry = {
  task: '990001',
  profile: 'demo-shop',
  owner: 'manual',
  slot: 0,
  fePort: 5190,
  apiPort: 8090,
  repos: [
    {
      name: 'frontend',
      branch: 'task-990001',
      path: '/workspace/worktrees/demo-shop/frontend/t990001',
    },
    {
      name: 'backend',
      branch: 'task-990001',
      path: '/workspace/worktrees/demo-shop/backend/t990001',
    },
  ],
  standAlive: true,
  feAlive: true,
  profileBinding: 'verified',
  removable: true,
  removableReason: null,
  updatedAt: '2026-10-22T09:30:00.000Z',
  actions: [{
    id: 'check',
    label: 'Проверить стенд',
    description: 'Проверка основных страниц и соединения с базой данных.',
    args: [],
    confirm: 'Запустить проверку на этом стенде?',
  }],
};

const baseJob: SandboxJob = {
  task: '990002',
  profile: 'demo-shop',
  action: 'up',
  actionId: null,
  actionLabel: null,
  state: 'running',
  index: 4,
  total: 11,
  label: 'Копируем базу данных',
  message: '',
  startedAt: '2026-10-22T09:35:00.000Z',
  finishedAt: null,
};

/**
 * Полное приложение получает синтетический обзор; POST записывается только в памяти.
 * Проверка диалогов и журналов не создаёт контейнеров и не обращается к рабочим данным.
 */
async function fixture(t: TestContext) {
  const client = await clientBrowser(t);
  const overview: SandboxOverview = {
    profiles: [{
      id: 'demo-shop',
      canRaise: true,
      reason: null,
    }],
    sandboxes: [
      structuredClone(baseEntry),
      {
        ...structuredClone(baseEntry),
        task: '990002',
        slot: 1,
        fePort: null,
        apiPort: null,
        standAlive: null,
        repos: [],
        actions: [],
        removable: false,
        removableReason: 'job_running',
      },
      {
        ...structuredClone(baseEntry),
        task: '1427',
        owner: 'pipeline',
        slot: 2,
        removable: false,
        removableReason: 'pipeline_owned',
        repos: [{
          name: 'frontend',
          branch: 'task-1427',
          path: '/workspace/worktrees/demo-shop/frontend/t1427',
        }],
        actions: [],
      },
    ],
    jobs: [structuredClone(baseJob)],
    manualRange: { from: 990000, to: 999999 },
  };
  const state = {
    overview,
    failRead: false,
    writes: [] as Array<{ path: string; body: unknown }>,
  };

  /**
   * Все ручки песочниц перехватываются до перехода, включая чтение после действия.
   * Ответы меняются через state, поэтому refresh проверяет настоящий store и декодер.
   */
  async function open(width = 1280, height = 900, touch = width < 500) {
    const page: Page = await client.browser.newPage({
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
    });
    const errors: string[] = [];

    page.setDefaultTimeout(10000);
    await page.addInitScript(() => localStorage.setItem('grigdesk-ui-language', 'ru'));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(/\/api\/sandboxes(?:\/[^?]*)?$/, async (route) => {
      const path = new URL(route.request().url()).pathname;

      if (route.request().method() === 'POST') {
        state.writes.push({ path, body: route.request().postDataJSON() });
        await route.fulfill({ json: { task: baseJob.task, job: baseJob } });

        return;
      }
      if (path.endsWith('/log')) {
        await route.fulfill({ json: {
          task: baseEntry.task,
          action: 'run',
          state: 'done',
          text: 'Проверка страниц: успешно.\nБаза данных: доступна.',
          truncated: false,
        } });

        return;
      }

      const json = { error: 'sandbox_error', message: 'Не удалось прочитать состояние песочниц.' };

      await route.fulfill(state.failRead ? { status: 503, json } : { json: state.overview });
    });
    await page.goto(`${client.origin}#/sandboxes`);
    await page.locator('.sandboxes > .ui-pane-header').waitFor();
    await page.getByRole('button', { name: 'Обновить песочницы' })
      .filter({ hasNot: page.locator('[aria-hidden="true"].ui-button__content') }).waitFor();

    return { page, errors };
  }

  return {
    ...client,
    state,
    open,
  };
}

/**
 * Измеряется фактическая ширина списка и раскрытых секций, включая длинные пути.
 * Внутренняя вертикальная прокрутка допустима, горизонтальная у рабочей области — нет.
 */
async function geometry(page: Page) {
  return page.locator('.sandboxes').evaluate((root) => {
    const selectors = '.sandboxes__scroll, .sandbox-card, .ui-workspace-section__body';
    // Закрытый details сохраняет расчётную ширину потомков, но не рисует их.
    // Содержимое раскрытий проверяется после открытия ниже в этом же сценарии.
    const panels = [...root.querySelectorAll(selectors)]
      .filter((node) => node.checkVisibility());
    const controls = [...root.querySelectorAll('.sandboxes__filters input, .sandboxes__filters select')];
    const cards = [...root.querySelectorAll('.sandboxes__list .sandbox-card')];
    const card = cards[0]!;
    const ports = card.querySelector('.sandbox-card__ports')!.getBoundingClientRect();
    const links = [...card.querySelectorAll('.sandbox-card__ports a')]
      .map((node) => node.getBoundingClientRect());
    const run = card.querySelector('.sandbox-card__run button')!.getBoundingClientRect();
    const headings = card.querySelector('h3')!.getBoundingClientRect();
    const overflowing = panels.filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => ({
        className: node.className,
        width: node.clientWidth,
        scroll: node.scrollWidth,
      }));

    return {
      fits: root.scrollWidth <= root.clientWidth + 1 && root.getBoundingClientRect().right <= innerWidth + 1,
      panelsFit: panels.every((node) => node.scrollWidth <= node.clientWidth + 1),
      header: root.querySelector('.ui-pane-header')!.getBoundingClientRect().height,
      titleHeight: root.querySelector('h1')!.getBoundingClientRect().height,
      controls: controls.map((node) => node.getBoundingClientRect().height),
      overflowing,
      cardsGap: cards[1] ? cards[1].getBoundingClientRect().top - card.getBoundingClientRect().bottom : null,
      cardBorder: getComputedStyle(card).borderTopWidth,
      portsAligned: links.every((link) => link.top === links[0]!.top && link.height === links[0]!.height),
      portsHeight: links[0]!.height,
      runHeight: run.height,
      actionAxis: Math.abs(ports.left - run.left) < 1 && Math.abs(ports.right - run.right) < 1,
      headingAxis: Math.abs(headings.left - ports.left) < 1,
    };
  });
}

test('песочницы: геометрия списка и формы на двенадцати ширинах и в альбомном touch', async (t) => {
  const client = await fixture(t);
  const sizes = [
    [1920, 1080], [1600, 900], [1440, 900], [1280, 720], [1024, 768], [900, 700],
    [768, 1024], [600, 800], [480, 800], [390, 844], [360, 740], [320, 640], [844, 390],
  ];

  for (const [width, height] of sizes) {
    const touch = width! < 500 || height === 390;
    const { page, errors } = await client.open(width, height, touch);

    await page.locator('.sandbox-card').first().waitFor();

    const measured = await geometry(page);

    await writeFile(`${client.artifacts}/geometry-${width}.json`, JSON.stringify(measured, null, 2));
    await page.screenshot({ path: `${client.artifacts}/sandboxes-${width}.png` });
    assert.equal(measured.fits, true, `область ${width}`);
    assert.equal(measured.panelsFit, true, `содержимое ${width}: ${JSON.stringify(measured.overflowing)}`);
    assert.ok(measured.titleHeight <= 22, `заголовок остаётся в одну строку ${width}`);
    assert.deepEqual(measured.controls, touch ? [44, 44] : [32, 32]);
    assert.equal(measured.cardsGap, 12, `стенды разделены ${width}`);
    assert.equal(measured.cardBorder, '1px');
    assert.equal(measured.portsAligned, true);
    assert.equal(measured.actionAxis, true, `ось действий ${width}`);
    assert.equal(measured.headingAxis, true, `ось заголовка ${width}`);
    assert.equal(measured.portsHeight, touch ? 44 : 32);
    assert.equal(measured.runHeight, touch ? 44 : 32);

    if (width! >= 768 && !touch) {
      assert.equal(measured.header, 36);
    }

    await page.getByRole('button', { name: '+ Поднять стенд', exact: true }).click();
    await page.locator('.sandbox-raise').waitFor();

    const form = await page.locator('.sandbox-raise').evaluate((root) => {
      const fields = [...root.querySelectorAll('select, input:not([type="checkbox"])')]
        .map((node) => node.getBoundingClientRect());
      const button = root.querySelector('button[type="submit"]')!.getBoundingClientRect();

      return {
        heights: fields.map((field) => field.height),
        aligned: fields[0]!.top === fields[1]!.top || fields[0]!.left === fields[1]!.left,
        buttonHeight: button.height,
      };
    });

    assert.deepEqual(form.heights, touch ? [44, 44] : [32, 32]);
    assert.equal(form.aligned, true, `ось формы ${width}`);
    assert.equal(form.buttonHeight, touch ? 44 : 32);
    await page.screenshot({ path: `${client.artifacts}/sandboxes-create-${width}.png` });
    await page.getByRole('button', { name: 'Профиль: Подсказка' }).click();
    await page.getByRole('tooltip').filter({ hasText: 'Профиль определяет проект' }).waitFor();
    await page.screenshot({ path: `${client.artifacts}/sandboxes-help-${width}.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Скрыть форму', exact: true }).click();
    await page.locator('.sandbox-card__details > summary').first().click();
    await page.locator('.sandbox-card__removal > summary').first().click();
    await page.locator('.sandbox-card__actions').first().scrollIntoViewIfNeeded();
    assert.equal((await geometry(page)).panelsFit, true, `раскрытые секции ${width}`);
    await page.screenshot({ path: `${client.artifacts}/sandboxes-details-${width}.png` });
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('песочницы: ввод переживает сворачивание, подъём и снос требуют подтверждения', async (t) => {
  const client = await fixture(t);
  const { page, errors } = await client.open();

  await page.getByRole('button', { name: '+ Поднять стенд', exact: true }).click();
  await page.getByText('Без привязки к задаче', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Номер задачи', exact: true }).fill('12345');
  await page.getByRole('button', { name: 'Скрыть форму', exact: true }).click();
  await page.getByRole('button', { name: '+ Поднять стенд', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Номер задачи', exact: true }).inputValue(), '12345');
  await page.getByRole('button', { name: 'Поднять стенд', exact: true }).click();
  assert.equal(client.state.writes.length, 0);
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST'),
    page.getByRole('dialog').getByRole('button', { name: 'Поднять', exact: true }).click(),
  ]);
  assert.deepEqual(client.state.writes[0], {
    path: '/api/sandboxes',
    body: { profile: 'demo-shop', task: '12345' },
  });

  await page.locator('.sandbox-card__removal > summary').first().click();
  await page.getByRole('button', { name: 'Снести стенд', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal(client.state.writes.length, 1);
  await page.getByRole('button', { name: 'Снести вместе с изменениями', exact: true }).click();
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST'),
    page.getByRole('dialog').getByRole('button', { name: 'Снести', exact: true }).click(),
  ]);
  assert.deepEqual(client.state.writes[1], { path: '/api/sandboxes/990001/down', body: { force: true } });
  assert.deepEqual(errors, []);
});

test('песочницы: ошибка чтения, повтор, пустое состояние и исчезнувший профиль', async (t) => {
  const client = await fixture(t);

  client.state.failRead = true;
  client.state.overview.sandboxes = [];
  client.state.overview.jobs = [];

  const { page, errors } = await client.open(390);

  await page.getByRole('alert').filter({ hasText: 'Не удалось прочитать' }).waitFor();
  assert.equal(await page.locator('.sandbox-raise').isVisible(), false);
  assert.equal(await page.getByText('Стендов пока нет.', { exact: false }).count(), 0);
  client.state.failRead = false;
  await page.getByRole('button', { name: 'Обновить песочницы' }).click();
  await page.locator('.sandbox-raise').waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Профиль', exact: true }).inputValue(), 'demo-shop');
  await page.screenshot({ path: `${client.artifacts}/sandboxes-empty.png` });
  client.state.overview.profiles = [];
  await page.getByRole('button', { name: 'Обновить песочницы' }).click();
  await page.getByRole('alert').filter({ hasText: 'Нет профилей' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Поднять стенд', exact: true })
    .getAttribute('aria-disabled'), 'true');
  assert.deepEqual(errors, []);
});

test('песочницы: фильтры, журнал и длинные данные в узком доке desktop', async (t) => {
  const client = await fixture(t);
  const entry = client.state.overview.sandboxes[0]!;

  entry.profile = 'профиль_с_длинным_названием_'.repeat(5);
  entry.repos[0]!.branch = 'ветка_проверки_'.repeat(15);
  entry.repos[0]!.path = '/workspace/' + 'очень_длинная_папка_'.repeat(15);
  entry.actions![0]!.label = 'Проверить_все_сценарии_'.repeat(10);
  client.state.overview.jobs.push({
    ...baseJob,
    task: entry.task,
    action: 'run',
    state: 'done',
    message: 'Проверка завершена',
  });

  const { page, errors } = await client.open();

  await page.locator('.sandboxes').evaluate((root) => {
    (root as HTMLElement).style.width = '600px';
  });
  await page.getByRole('searchbox', { name: 'Поиск стенда' }).fill('t990001');
  await page.getByText('Найдено: 1 из 3', { exact: true }).waitFor();
  await page.locator('.sandbox-card__details > summary').click();
  await page.getByRole('button', { name: 'Журнал задания', exact: true }).click();
  await page.getByText('Проверка страниц: успешно.', { exact: false }).waitFor();
  assert.equal((await geometry(page)).panelsFit, true);
  await page.screenshot({ path: `${client.artifacts}/sandboxes-narrow-dock.png` });
  await page.getByRole('combobox', { name: 'Какие стенды показать' }).selectOption('pipeline');
  await page.getByText('Подходящих стендов нет.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  assert.equal(await page.locator('.sandbox-card').count(), 3);
  assert.deepEqual(errors, []);
});
