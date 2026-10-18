import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { build, preview } from '../../mobile/node_modules/vite/dist/node/index.js';
import vue from '../../mobile/node_modules/@vitejs/plugin-vue/dist/index.mjs';
import playwright from '../../mobile/node_modules/playwright-core/index.js';
import { chromiumPath } from '../../tests/mobile/visual/browser.mjs';
import {
  inspectFrame,
  navCoversContent,
  scrollToEnd,
} from '../../tests/mobile/visual/rules.mjs';
import type { PhoneEmulator } from './emulator.mts';

const { chromium } = playwright;

type Options = {
  api: {
    port: number;
    token: string;
  };
  phone: PhoneEmulator;
  qr: string;
  command: (action: string, extra?: Record<string, unknown>) => Promise<any>;
  stopRelay: () => Promise<void>;
  startRelay: () => Promise<void>;
  output: string;
  viewport?: {
    width: number;
    height: number;
  };
  revoke?: () => Promise<void>;
};

/**
 * Браузер загружает настоящий mobile UI через DevLink и отдельный loopback bridge с токеном.
 * Product fixtures не подставляются: все данные и action tokens приходят из реального фасада.
 */
export async function browserFlow(options: Options) {
  const previous = {
    link: process.env.VITE_LINK,
    token: process.env.VITE_EMULATOR_TOKEN,
  };

  process.env.VITE_LINK = 'dev';
  process.env.VITE_EMULATOR_TOKEN = options.api.token;

  const dist = path.join(options.output, 'dev-dist');

  await build({
    root: path.resolve('mobile'),
    configFile: false,
    plugins: [vue()],
    define: { 'import.meta.env.VITE_APP_VERSION': '"0.1.0"' },
    build: {
      outDir: dist,
      emptyOutDir: true,
    },
  });

  const vite = await preview({
    root: path.resolve('mobile'),
    configFile: false,
    build: { outDir: dist },
    preview: {
      host: '127.0.0.1',
      port: 0,
      proxy: {
        '/__mobile': {
          target: `http://127.0.0.1:${options.api.port}`,
          rewrite: (value) => value.replace(/^\/__mobile/, ''),
        },
      },
    },
  });
  let browser;

  try {
    const initialRuns = (await options.command('runs')).count;

    browser = await chromium.launch({
      executablePath: await chromiumPath(),
      headless: true,
      args: ['--no-sandbox'],
    });

    const page = await browser.newPage({
      viewport: options.viewport || {
        width: 390,
        height: 844,
      },
      hasTouch: true,
    });
    const errors: string[] = [];
    const frames: Array<{
      name: string;
      issues: unknown[];
    }> = [];
    const directory = path.join(options.output, 'browser');

    await mkdir(directory, { recursive: true });
    page.setDefaultTimeout(40000);

    /**
     * Каждый шаг снимается после ухода с QR формы, без секретов в кадре или отчёте.
     * Те же правила проверяют начало и конец страницы, а ошибки браузера закрывают сценарий.
     */
    async function capture(name: string) {
      const issues = await page.evaluate(inspectFrame);

      await page.screenshot({ path: path.join(directory, name + '.png') });

      if (!(await page.getByRole('dialog').count())) {
        await page.evaluate(scrollToEnd);
        issues.push(...(await page.evaluate(inspectFrame)));

        if (await page.evaluate(navCoversContent)) {
          issues.push({ rule: 'tabbar-covers-content' });
        }
      }

      frames.push({
        name,
        issues,
      });
      await writeFile(
        path.join(directory, 'report.json'),
        JSON.stringify(
          {
            frames,
            errors,
          },
          null,
          2,
        ) + '\n',
      );
      assert.deepEqual(issues, [], `Нарушен кадр ${name}`);
      assert.deepEqual(errors, [], `Ошибка браузера на шаге ${name}`);
    }

    page.on('pageerror', () => errors.push('Необработанная ошибка интерфейса'));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push('Ошибка console.error');
      }
    });
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`);
    await page
      .getByRole('heading', {
        name: 'Подключить GrigDesk',
        exact: true,
      })
      .waitFor();
    await page.getByLabel('Вставить код').fill(options.qr);
    await page
      .getByRole('button', {
        name: 'Добавить',
        exact: true,
      })
      .click();
    console.log('V4: привязка создана');
    await page
      .getByRole('link', {
        name: 'Чаты',
        exact: true,
      })
      .click();
    await page
      .getByRole('switch', {
        name: 'Показывать архив',
        exact: true,
      })
      .waitFor();
    await capture('chats');
    await page.getByRole('button', { name: 'Новый чат', exact: true }).click();
    await page.getByRole('combobox', { name: 'Модель', exact: true })
      .selectOption('["test-provider","test-model"]');
    await page.getByRole('button', { name: 'Создать чат', exact: true }).click();
    await page.getByRole('heading', { name: 'Новый чат', exact: true }).waitFor();
    await page.locator('.chat-folder').click();
    await page.getByRole('combobox', { name: 'Папка', exact: true }).selectOption('path');
    await page.getByRole('textbox', { name: 'Абсолютный путь на сервере', exact: true }).fill('/tmp');
    await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
    await page.getByRole('combobox', { name: 'Память разговора', exact: true }).selectOption('reset');
    await page.getByRole('button', { name: 'Применить', exact: true }).click();
    await page.getByRole('button', { name: 'Папка: /tmp', exact: true }).waitFor();
    await capture('chat-created-workspace');
    await page.getByRole('navigation').getByRole('link', { name: 'Чаты', exact: true }).click();
    await page.getByText('Чат интеграции', { exact: true }).click();
    await page.getByLabel('Сообщение', { exact: true }).fill('Сообщение из настоящего DevLink');
    await page
      .getByRole('button', {
        name: 'Отправить',
        exact: true,
      })
      .click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>('.mobile-composer textarea')?.value === '',
    );
    await options.command('ask', { count: initialRuns + 1 });
    console.log('V4: сообщение принято исполнителем');
    await page.getByText('Продолжить проверку?', { exact: true }).waitFor();
    await capture('question');
    await page
      .getByRole('button', {
        name: 'Да',
        exact: true,
      })
      .click();
    await page
      .getByRole('button', {
        name: 'Ответить',
        exact: true,
      })
      .click();
    await options.command('answer');
    await options.command('release', { count: initialRuns + 1 });
    await page.getByText('Ответ без браузера', { exact: false }).first().waitFor();
    await page.locator('.mobile-media').first().scrollIntoViewIfNeeded();
    await page.locator('.mobile-media img').first().waitFor();
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('.mobile-media img');

      return img?.complete && img.naturalWidth > 0;
    });
    await capture('chat-media');
    await page
      .getByRole('link', {
        name: 'Конвейер',
        exact: true,
      })
      .click();
    console.log('V4: чат, вопрос и media пройдены');
    await page.locator('a[href="#/tasks/7"]').click();
    await page
      .getByRole('button', {
        name: 'План',
        exact: true,
      })
      .click();
    await page.locator('.mobile-plan-text').waitFor();
    await capture('task-plan');
    await page
      .getByRole('button', {
        name: 'Принять',
        exact: true,
      })
      .click();
    await page.getByRole('dialog').waitFor();
    await capture('gate-confirm');
    await page.getByRole('dialog')
      .getByRole('button', {
        name: 'Принять',
        exact: true,
      })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page
      .getByRole('link', {
        name: 'Задачи',
        exact: true,
      })
      .click();
    await page.locator('a[href="#/b24/7"]').click();
    await page
      .getByRole('heading', {
        name: 'Задача Б24',
        exact: true,
      })
      .waitFor();
    await capture('b24-task');
    await page
      .getByRole('button', {
        name: 'Запустить на конвейере',
        exact: true,
      })
      .click();
    await page.getByText('Задача уже на конвейере.', { exact: true }).waitFor();
    await capture('b24-launch-options');
    console.log('V4: конвейер и Б24 пройдены');
    await page
      .getByRole('link', {
        name: 'Чаты',
        exact: true,
      })
      .click();
    await page.getByText('Чат интеграции', { exact: true }).click();
    await options.stopRelay();
    await page.getByLabel('Сообщение', { exact: true }).fill('Сохранено во время обрыва');
    await page
      .getByRole('button', {
        name: 'Отправить',
        exact: true,
      })
      .click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>('.mobile-composer textarea')?.value === '',
    );
    assert.equal(
      options.phone
        .getOutbox()
        .items.some((item) => JSON.parse(item.body).text === 'Сохранено во время обрыва'),
      true,
    );
    await capture('chat-outbox');
    await options.startRelay();

    try {
      await options.command('release', { count: initialRuns + 2 });
    } catch (failure) {
      console.log('V4: очередь после reconnect', options.phone.diagnostics());
      console.log(
        'V4: состояние очереди UI',
        await page.locator('.mobile-message .ui-chip').allTextContents(),
      );
      await capture('reconnect-failure');

      throw failure;
    }

    console.log('V4: offline сообщение доставлено');

    const deadline = Date.now() + 20000;

    while (options.phone.getOutbox().items.some((item) => item.clientId)) {
      assert.ok(Date.now() < deadline, 'Outbox не подтверждён после ready');
      await page.waitForTimeout(100);
    }

    options.phone.lock();
    await page.getByText('Приложение заблокировано', { exact: true }).waitFor();
    assert.equal(await page.locator('.mobile-feed').count(), 0);
    await capture('lock');
    await page
      .getByRole('button', {
        name: 'Разблокировать',
        exact: true,
      })
      .click();
    await page
      .getByRole('link', {
        name: 'Настройки',
        exact: true,
      })
      .click();
    await page.getByText('Версия приложения: 0.1.0', { exact: true }).waitFor();
    await capture('more');

    if (options.revoke) {
      await options.revoke();
      await page
        .getByRole('heading', {
          name: 'Телефон отозван в GrigDesk',
          exact: true,
        })
        .waitFor();
      assert.equal(await page.locator('.mobile-feed').count(), 0);
      await capture('revoked');
    }
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => {
      vite.httpServer.close(() => resolve());

      if ('closeAllConnections' in vite.httpServer) {
        vite.httpServer.closeAllConnections();
      }
    });

    if (previous.link === undefined) {
      delete process.env.VITE_LINK;
    } else {
      process.env.VITE_LINK = previous.link;
    }
    if (previous.token === undefined) {
      delete process.env.VITE_EMULATOR_TOKEN;
    } else {
      process.env.VITE_EMULATOR_TOKEN = previous.token;
    }
  }
}
