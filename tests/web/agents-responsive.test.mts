import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Page } from '../../desktop/node_modules/playwright-core/index.js';
import type { AgentCard } from '../../shared/pipeline/agentsContracts.ts';

import { clientBrowser } from './helpers/client-browser.mjs';

const baseAgent: AgentCard = {
  id: 'scout',
  kind: 'agent',
  label: 'Разведка',
  sub: '',
  key: 'SCOUT',
  tier: 'reasoning',
  effort: 'high',
  timeout: 900,
  budget: 0,
  readonly: true,
  optional: false,
  prompt: 'Изучи задачу и устройство проекта.\n\nНайди затронутые части кода и предложи план работы.'
    + '\nУкажи риски и способы проверки результата.',
};

/**
 * Настоящее приложение получает только синтетические роли и реестр усилий.
 * Мутации меняют копии в памяти; стенд не обращается к рабочему API и файлам агентов.
 */
async function fixture(t: TestContext) {
  const client = await clientBrowser(t);
  const state = {
    agents: [
      baseAgent,
      {
        ...baseAgent,
        id: 'developer',
        label: 'Разработка',
        tier: 'balanced',
        readonly: false,
      },
      {
        ...baseAgent,
        id: 'reviewer',
        label: 'Проверка кода',
        readonly: true,
      },
      {
        ...baseAgent,
        id: 'tests',
        kind: 'code',
        label: 'Проверка проекта',
        tier: 'cheap',
        effort: '',
      },
      {
        ...baseAgent,
        id: 'approval',
        kind: 'human',
        label: 'Приёмка результата',
        tier: '',
        effort: '',
      },
    ].map((agent) => ({ ...agent })),
    failList: false,
    failWrite: false,
    writes: [] as Array<{ method: string; body: AgentCard | null }>,
  };

  /**
   * Перехват ставится до перехода на страницу, включая первоначальную загрузку.
   * Ошибки Vue собираются отдельно от ожидаемых HTTP-отказов фикстуры.
   */
  async function open(width = 1280, height = 800, touch = width < 500) {
    const page: Page = await client.browser.newPage({
      viewport: { width, height },
      hasTouch: touch,
      isMobile: width < 500,
    });
    const errors: string[] = [];

    await page.addInitScript(() => localStorage.setItem('grigdesk-ui-language', 'ru'));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/providers', (route) => route.fulfill({ json: { providers: [{
      id: 'fixture',
      name: 'Тестовый исполнитель',
      available: true,
      models: [{
        id: 'fixture-model',
        name: 'Тестовая модель',
        efforts: ['low', 'high', 'max'],
      }],
    }] } }));
    await page.route(/\/api\/agents(?:\/[^?]*)?$/, async (route) => {
      const method = route.request().method();
      const pathname = new URL(route.request().url()).pathname;
      const id = decodeURIComponent(pathname.split('/').at(-1) || '');

      if (method === 'GET') {
        await route.fulfill(state.failList
          ? { status: 503, json: { error: 'Библиотека временно недоступна' } }
          : { json: { agents: state.agents } });

        return;
      }

      const body = route.request().postDataJSON() as AgentCard | null;

      state.writes.push({ method, body });

      if (state.failWrite) {
        await route.fulfill({ status: 503, json: { error: 'Не удалось записать агента' } });

        return;
      }
      if (id === 'install') {
        const created = state.agents.some((agent) => agent.id === 'seed') ? [] : ['seed'];

        if (created.length) {
          state.agents.push({
            ...baseAgent,
            id: 'seed',
            label: 'Стандартная роль',
          });
        }

        await route.fulfill({ json: {
          ok: true,
          created,
          skipped: [],
        } });

        return;
      }
      if (method === 'DELETE') {
        state.agents = state.agents.filter((agent) => agent.id !== id);
        await route.fulfill({ json: { ok: true } });

        return;
      }

      assert.ok(body);

      const saved = { ...body, label: body.label.trim() };

      if (method === 'POST') {
        state.agents.push(saved);
      } else {
        state.agents = state.agents.map((agent) => agent.id === id ? saved : agent);
      }

      await route.fulfill({ json: saved });
    });
    await page.goto(`${client.origin}#/agents`);
    await page.locator('.agents-page .catalog').waitFor();
    await page.getByRole('button', { name: 'Стандартный набор', exact: true }).waitFor();

    return { page, errors };
  }

  return {
    ...client,
    state,
    open,
  };
}

/**
 * Прокрутка принадлежит каталогу и форме; закреплённые действия остаются в окне.
 * Реальные размеры полей и шапок сравниваются с принятой геометрией GrigDesk.
 */
async function geometry(page: Page) {
  return page.locator('.agents-page').evaluate((root) => {
    const visible = (node: Element) => node.getBoundingClientRect().width > 0;
    const box = root.getBoundingClientRect();
    const footer = root.querySelector('.editor-footer')?.getBoundingClientRect();
    const title = root.querySelector('.editor h2')?.getBoundingClientRect();
    const content = root.querySelector('.library-note')?.getBoundingClientRect();

    return {
      aligned: !title?.width || title.left === content?.left,
      fits: root.scrollWidth <= root.clientWidth + 1 && box.right <= innerWidth + 1,
      panelsFit: [...root.querySelectorAll('.catalog-scroll, .form-scroll')].filter(visible)
        .every((node) => node.scrollWidth <= node.clientWidth + 1),
      headers: [...root.querySelectorAll('.ui-pane-header')].filter(visible)
        .map((node) => node.getBoundingClientRect().height),
      footerVisible: !footer?.width || footer.bottom <= innerHeight + 1,
      fields: [...root.querySelectorAll('.basic-fields input, .basic-fields select')].filter(visible)
        .map((node) => node.getBoundingClientRect().height),
      actions: [...root.querySelectorAll('.editor-footer button')].filter(visible)
        .map((node) => node.getBoundingClientRect().height),
    };
  });
}

test('агенты: композиция, формы и адаптив настоящего приложения', { timeout: 180000 }, async (t) => {
  const client = await fixture(t);

  await t.test('каталог и редактор помещаются на desktop и touch', async () => {
    for (const [width, height] of [[1440, 1000], [1280, 800], [1024, 768], [768, 1024],
      [390, 844], [320, 640]] as const) {
      const { page, errors } = await client.open(width, height);

      await page.locator('[data-agent-id="scout"]').waitFor();

      if (width <= 1024) {
        await page.screenshot({ path: `${client.artifacts}/agents-${width}-catalog.png` });
        await page.locator('[data-agent-id="scout"]').click();
      }

      await page.getByRole('textbox', { name: 'Название агента', exact: true }).waitFor();

      const measured = await geometry(page);
      const controlHeight = width < 500 ? 44 : 32;

      if (width >= 1024 || width < 500) {
        assert.equal(measured.aligned, true, `ось формы ${width}`);
      }

      assert.equal(measured.fits, true, `область ${width}`);
      assert.equal(measured.panelsFit, true, `панели ${width}`);
      assert.equal(measured.footerVisible, true, `действия ${width}`);
      assert.deepEqual(measured.fields, [controlHeight, controlHeight]);
      assert.deepEqual(measured.actions, [controlHeight, controlHeight]);

      if (width >= 1280) {
        assert.deepEqual(measured.headers, [36, 36]);
      }

      await page.screenshot({ path: `${client.artifacts}/agents-${width}.png` });

      if (width < 500) {
        await page.getByText('Технические параметры', { exact: true }).click();
        await page.getByRole('spinbutton', { name: 'Время на этап, сек', exact: true })
          .scrollIntoViewIfNeeded();

        const numbers = await page.locator('.technical input[type="number"]').evaluateAll((nodes) => (
          nodes.map((node) => node.getBoundingClientRect().height)
        ));

        const flags = await page.locator('.role-flags .ui-checkbox').evaluateAll((nodes) => (
          nodes.map((node) => node.getBoundingClientRect().height)
        ));

        assert.deepEqual(numbers, [44, 44]);
        assert.deepEqual(flags, [44, 44]);
        assert.equal((await geometry(page)).panelsFit, true);
        assert.equal((await geometry(page)).footerVisible, true);
        await page.screenshot({ path: `${client.artifacts}/agents-${width}-technical.png` });
      }

      assert.deepEqual(errors, []);
      await page.close();
    }
  });

  await t.test('сенсорные размеры работают и на широком экране', async () => {
    const { page, errors } = await client.open(1280, 800, true);

    await page.getByRole('textbox', { name: 'Название агента', exact: true }).waitFor();

    const measured = await geometry(page);

    assert.deepEqual(measured.fields, [44, 44]);
    assert.deepEqual(measured.actions, [44, 44]);
    assert.deepEqual(measured.headers, [52, 52]);
    assert.equal(measured.footerVisible, true);
    assert.equal(measured.panelsFit, true);
    assert.equal(measured.aligned, true);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('модель скрыта для человека и команды, рекомендации сохраняются', async () => {
    const { page, errors } = await client.open();
    const kind = page.getByLabel('Тип роли', { exact: true });
    const tier = page.getByLabel('Класс модели', { exact: true });
    const effort = page.getByLabel('Глубина рассуждений', { exact: true });

    await kind.selectOption('human');
    await tier.waitFor({ state: 'hidden' });
    await page.getByText('Для решения человека инструкция необязательна:', { exact: false }).waitFor();
    await kind.selectOption('code');
    await page.getByText('Сам запуск настраивают в маршруте.', { exact: false }).waitFor();
    assert.equal(await effort.isVisible(), false);
    await kind.selectOption('agent');
    await tier.waitFor();
    assert.equal(await tier.inputValue(), 'reasoning');
    assert.equal(await effort.inputValue(), 'high');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('сохранение отправляет все поля, отмена возвращает загруженный снимок', async () => {
    const { page, errors } = await client.open();
    const label = page.getByRole('textbox', { name: 'Название агента', exact: true });

    await label.fill('  Разведка проекта  ');
    await page.getByRole('textbox', { name: 'Инструкция роли', exact: true }).fill('Новая инструкция');
    await page.getByText('Технические параметры', { exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Время на этап, сек', exact: true }).fill('1200');
    await page.getByText('Этап можно пропустить', { exact: true }).click();
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByRole('button', { name: 'Сохранить', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => (
      document.querySelector('.save-state')?.textContent?.trim() === 'Сохранено'
    ));

    const write = client.state.writes.at(-1);

    assert.equal(write?.method, 'PUT');
    assert.equal(write?.body?.timeout, 1200);
    assert.equal(write?.body?.optional, true);
    assert.equal(write?.body?.prompt, 'Новая инструкция');
    assert.equal(await label.inputValue(), 'Разведка проекта');
    await label.fill('Неприменённое название');
    await page.getByRole('button', { name: 'Отменить', exact: true }).click();
    assert.equal(await label.inputValue(), 'Разведка проекта');
    assert.equal(client.state.writes.at(-1), write);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('узкие панели сохраняют ввод и поиск, справка доступна с клавиатуры', async () => {
    const { page, errors } = await client.open(390, 844);

    await page.getByRole('searchbox', { name: 'Поиск агентов', exact: true }).fill('scout');
    await page.locator('[data-agent-id="scout"]').click();
    await page.getByRole('textbox', { name: 'Название агента', exact: true }).fill('Локальная правка');
    await page.getByRole('button', { name: '← Агенты', exact: true }).click();
    assert.equal(await page.getByRole('searchbox', { name: 'Поиск агентов' }).inputValue(), 'scout');
    await page.getByRole('button', { name: 'Вернуться к агенту', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Название агента', exact: true }).inputValue(),
      'Локальная правка');
    await page.getByRole('button', { name: 'Название агента: Подсказка', exact: true }).focus();
    await page.getByRole('tooltip').waitFor();
    assert.match(await page.getByRole('tooltip').innerText(), /Название роли/);
    await page.keyboard.press('Escape');
    await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('создание и установка набора не стирают локальную форму', async () => {
    const { page, errors } = await client.open();

    await page.getByRole('button', { name: 'Новый агент', exact: true }).click();
    await page.getByRole('textbox', { name: 'Название агента', exact: true }).fill('Своя роль');
    await page.getByRole('textbox', { name: 'ID агента', exact: true }).fill('custom_role');
    await page.getByRole('button', { name: 'Стандартный набор', exact: true }).click();
    await page.waitForFunction(() => (
      document.querySelector('.catalog-footer')?.textContent?.includes('Установлено')
    ));
    assert.equal(await page.getByRole('textbox', { name: 'ID агента', exact: true }).inputValue(),
      'custom_role');
    assert.equal(await page.getByRole('textbox', { name: 'Название агента', exact: true }).inputValue(),
      'Своя роль');
    await page.screenshot({ path: `${client.artifacts}/agents-create.png` });
    await page.getByRole('button', { name: 'Создать агента', exact: true }).click();
    await page.waitForFunction(() => (
      document.querySelector('.save-state')?.textContent?.trim() === 'Сохранено'
    ));
    assert.equal(client.state.agents.find((agent) => agent.id === 'custom_role')?.label, 'Своя роль');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('отказ записи сохраняет ввод, отказ перехода и удаления оставляет агента', async () => {
    const { page, errors } = await client.open();
    const label = page.getByRole('textbox', { name: 'Название агента', exact: true });

    client.state.failWrite = true;
    await label.fill('Сохранить позже');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.locator('.save-state.bad').waitFor();
    assert.equal(await label.inputValue(), 'Сохранить позже');
    await page.locator('[data-agent-id="developer"]').click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.equal(await label.inputValue(), 'Сохранить позже');
    await page.getByRole('button', { name: 'Удалить', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.equal(await label.inputValue(), 'Сохранить позже');
    assert.deepEqual(errors, []);
    client.state.failWrite = false;
    await page.close();
  });

  await t.test('подтверждённая запись сохраняется при отказе перечитывания', async () => {
    const { page, errors } = await client.open();
    const label = page.getByRole('textbox', { name: 'Название агента', exact: true });

    await label.fill('Сохранённая роль');
    client.state.failList = true;
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.locator('.catalog-message [role="alert"]').waitFor();
    assert.equal(await label.inputValue(), 'Сохранённая роль');
    assert.equal(await page.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(), true);
    client.state.failList = false;
    await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
    await page.locator('.catalog-message [role="alert"]').waitFor({ state: 'hidden' });
    assert.equal(await label.inputValue(), 'Сохранённая роль');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('создание проверяет ID, а удаление выполняется только после подтверждения', async () => {
    const { page, errors } = await client.open();

    await page.getByRole('button', { name: 'Новый агент', exact: true }).click();
    await page.getByRole('textbox', { name: 'ID агента', exact: true }).fill('НЕВЕРНЫЙ ID');

    const writesBefore = client.state.writes.length;

    await page.getByRole('button', { name: 'Создать агента', exact: true }).click();
    assert.equal(client.state.writes.length, writesBefore);
    assert.equal(await page.getByRole('textbox', { name: 'ID агента', exact: true })
      .evaluate((node: HTMLInputElement) => node.validity.patternMismatch), true);
    await page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await page.locator('[data-agent-id="custom_role"]').click();
    await page.getByRole('button', { name: 'Удалить', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
    await page.locator('[data-agent-id="custom_role"]').waitFor({ state: 'hidden' });
    assert.equal(client.state.agents.some((agent) => agent.id === 'custom_role'), false);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('длинные данные и неизвестный тип доступны в узкой рабочей области', async () => {
    client.state.agents.push({
      ...baseAgent,
      id: 'custom_kind',
      label: 'Роль_с_очень_длинным_названием_для_проверки_переносов'.repeat(4),
      kind: 'custom',
      tier: 'custom-tier',
      effort: 'custom-effort',
    });

    const { page, errors } = await client.open();

    await page.locator('[data-agent-id="custom_kind"]').click();
    await page.locator('.agents-page').evaluate((root) => {
      (root as HTMLElement).style.width = '600px';
    });
    await page.getByText('Технические параметры', { exact: true }).click();
    assert.equal(await page.getByLabel('Тип роли', { exact: true }).inputValue(), 'custom');
    assert.equal(await page.getByLabel('Класс модели', { exact: true }).inputValue(), 'custom-tier');
    assert.equal(await page.getByLabel('Глубина рассуждений', { exact: true }).inputValue(), 'custom-effort');
    assert.equal((await geometry(page)).panelsFit, true);
    assert.equal((await geometry(page)).fits, true);
    await page.screenshot({ path: `${client.artifacts}/agents-narrow-dock.png` });
    assert.deepEqual(errors, []);
    await page.close();
  });
});
