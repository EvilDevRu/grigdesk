import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

import { chromium } from '../../../mobile/node_modules/playwright-core/index.mjs';
import { artifactsPath } from '../../../shared/runtime/dataHome.ts';
import { fixture, scenarios, sizes } from './scenarios.mjs';
import { inspectFrame, navCoversContent, scrollToEnd } from './rules.mjs';
import { chromiumPath } from './browser.mjs';
import { tabletInteractions } from './tabletInteractions.mjs';

const root = path.resolve(new URL('../../../', import.meta.url).pathname);
const outputIndex = process.argv.indexOf('--output');
const output = path.resolve(
  root,
  outputIndex > 0
    ? process.argv[outputIndex + 1]
    : path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'mobile-remote/visual'),
);
const dist = path.join(output, 'dist');
const execute = promisify(execFile);

// `--only имя,имя` и `--sizes имя,имя` сужают матрицу при доводке экрана; полный прогон
// без них остаётся приёмкой.
const pick = (flag, all, key = (item) => item) => {
  const index = process.argv.indexOf(flag);
  const names = index > 0 ? process.argv[index + 1]?.split(',') : null;

  return names ? all.filter((item) => names.includes(key(item))) : all;
};
/**
 * Сборка принадлежит этому прогону и не меняет web/dist работающего GrigDesk.
 * Chromium и static server закрываются в finally даже при ошибке кадра.
 */
async function main() {
  await mkdir(output, { recursive: true });

  const browser = await chromium.launch({
    executablePath: await chromiumPath(),
    headless: true,
    args: ['--no-sandbox'],
  });
  let server;

  try {
    if (process.argv.includes('--self-check')) {
      const page = await browser.newPage({
        viewport: {
          width: 320,
          height: 568,
        },
      });

      await page.setContent('<div id="app">Чистый кадр</div>');
      assert.deepEqual(await page.evaluate(inspectFrame), []);
      await page.setContent(
        '<div id="app"><div style="width:500px">Переполнение</div>' +
          '<button style="width:30px;height:30px">А</button>' +
          '<button style="position:absolute;left:10px;top:150px;width:44px;height:44px">Б</button>' +
          '<button style="position:absolute;left:20px;top:160px;width:44px;height:44px">В</button>' +
          '<p style="width:80px;white-space:nowrap;overflow:hidden">' +
          'Очень длинная обрезанная строка</p></div>',
      );

      const issues = await page.evaluate(inspectFrame);

      assert.deepEqual(
        issues.map((issue) => issue.rule).sort(),
        ['h-scroll', 'small-target', 'overlap', 'clipped-text'].sort(),
      );
      await writeFile(
        path.join(output, 'self-check.json'),
        JSON.stringify(
          {
            passed: true,
            issues,
          },
          null,
          2,
        ),
      );
      console.log('MV-05 PASS');

      return;
    }

    await new Promise((resolve, reject) => {
      const child = spawn('npm', ['--prefix', 'mobile', 'run', 'build', '--', '--outDir', dist], {
        cwd: root,
        env: {
          ...process.env,
          VITE_LINK: 'mock',
        },
        stdio: 'inherit',
      });

      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Build ${code}`))));
    });
    server = createServer(async (request, response) => {
      try {
        const name = new URL(request.url, 'http://localhost').pathname;
        const file = path.resolve(dist, '.' + (name === '/' ? '/index.html' : name));

        if (!file.startsWith(dist + '/')) {
          response.writeHead(400).end();

          return;
        }

        const data = await readFile(file);
        const mime = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
        };

        response
          .writeHead(200, {
            'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
          })
          .end(data);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const report = [];

    for (const name of pick('--only', scenarios)) {
      const data = await fixture(name);

      for (const [size, width, height] of pick('--sizes', sizes, (item) => item[0])) {
        for (const fontScale of [1, 1.3]) {
          const directory = path.join(output, `${size}-${fontScale}`);

          await mkdir(directory, { recursive: true });

          const context = await browser.newContext({
            screen: {
              width,
              height,
            },
            viewport: {
              width,
              height,
            },
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
          });
          const page = await context.newPage();
          const errors = [];

          page.on('pageerror', (error) => errors.push(error.message));
          page.on('console', (message) => {
            if (message.type() === 'error') {
              errors.push(message.text());
            }
          });
          await page.addInitScript(
            ({ data, fontScale }) => {
              const routes = {
                hello: 'hello',
                chats: 'chats',
                waiting: 'waiting',
                tasks: 'tasks',
                'b24/tasks': 'b24-tasks',
                app: 'app',
                'chat-options': 'chat-options',
                attention: 'attention',
              };
              const options = {
                state: {
                  ...data.state,
                  fontScale,
                },
                request: async (input) => {
                  if (data.name === 'offline') {
                    throw new Error('network');
                  }

                  const url = new URL(input.path, location.origin);
                  const route = url.pathname.replace('/api/mobile/v1/', '');
                  let kind = routes[route];

                  if ((data.name === 'tasks-error' && route === 'tasks') ||
                    (data.name === 'chat-error' && /^chats\//.test(route))) {
                    return {
                      status: 503,
                      body: JSON.stringify({ error: 'unavailable', message: 'Сервис временно недоступен.' }),
                    };
                  }

                  if (route.includes('/deliveries')) {
                    const ids = (url.searchParams.get('ids') || '').split(',');

                    return {
                      status: 200,
                      body: JSON.stringify({
                        deliveries: ids.map((clientId) => ({
                          clientId,
                          turnId: null,
                          state: 'unknown',
                          outcome: null,
                        })),
                      }),
                    };
                  }
                  if (route.startsWith('operations/')) {
                    return {
                      status: 200,
                      body: '{"state":"unknown","result":null}',
                    };
                  }
                  if (input.method === 'POST') {
                    kind = route.endsWith('/workspace/preview') ? 'workspace-preview'
                      : route.endsWith('/messages')
                      ? 'accepted'
                      : route.startsWith('waiting/')
                        ? 'waiting-result'
                        : route.split('/').at(-1);
                  } else if (!kind) {
                    kind = /^chats\//.test(route)
                      ? 'chat'
                      : /^waiting\//.test(route)
                        ? 'details'
                        : /^tasks\/[^/]+\/plan$/.test(route)
                          ? 'plan'
                          : /^tasks\//.test(route)
                            ? 'task'
                            : route.endsWith('/launch-options')
                              ? 'launch-options'
                              : 'b24-task';
                  }

                  const value = structuredClone(data.data[kind] || { error: 'mock_missing' });

                  if (kind === 'accepted') {
                    value.clientId = JSON.parse(input.body).clientId;
                  }

                  return {
                    status: kind === 'accepted' ? 202 : 200,
                    body: JSON.stringify(value),
                  };
                },
                outbox: data.outbox,
              };

              globalThis.__GRIGDESK_MOBILE_MOCK__ = options;
            },
            {
              data,
              fontScale,
            },
          );
          await page.goto(
            `http://127.0.0.1:${server.address().port}/?scenario=${name}#${data.route}`,
          );
          await page.waitForFunction(() => !document.body.textContent.includes('Подготовка…'));

          if (name === 'task' || name === 'gate-confirm') {
            await page
              .getByRole('button', {
                name: 'План',
                exact: true,
              })
              .click();
            await page.waitForSelector('.mobile-plan-text');

            if (name === 'gate-confirm') {
              await page
                .getByRole('button', {
                  name: 'Принять',
                  exact: true,
                })
                .click();
            }
          }
          if (name === 'launch-dialog') {
            await page
              .getByRole('button', {
                name: 'Запустить на конвейере',
                exact: true,
              })
              .click();
            await page.waitForSelector('[role=dialog]');
          }
          if (name === 'composer-long') {
            await page
              .locator('.mobile-composer textarea')
              .fill('Очень длинное сообщение\n'.repeat(20));
            await page.locator('.mobile-composer').scrollIntoViewIfNeeded();
          }

          const actions = {
            'chat-stop': 'Стоп',
            'permission-confirm': 'Разрешить',
            'task-stop': 'Остановить',
            'task-resume': 'Продолжить',
            'relay-remove': 'Удалить',
            'more-reset': 'Отвязать телефон',
            'more-update': 'Проверить обновление',
            'launch-options': 'Запустить на конвейере',
          };

          if (actions[name]) {
            await page.getByRole('button', { name: actions[name], exact: true }).first().click();
          }
          if (name === 'chats-archive') {
            await page.getByRole('switch', { name: 'Показывать архив', exact: true }).click();
          }
          if (name === 'chats-search-empty') {
            await page.getByRole('searchbox').fill('Несуществующий разговор');
          }

          await page.waitForTimeout(70);

          if (name === 'chat-tablet' && size.startsWith('pad7-')) {
            await tabletInteractions(page, {
              width,
              height,
              directory,
            });
          }

          if (name === 'chat-tablet-actions') {
            await page.locator('.activity-toggle').click();
            await page.locator('.activity-step').filter({ hasText: 'Bash' }).click();
            await page.waitForTimeout(70);
          }
          if (name === 'chat-tablet-layout') {
            await page.getByRole('button', { name: 'Вид чата', exact: true }).click();
          }
          if (name === 'chat-tablet-create') {
            if (!(await page.getByRole('button', { name: 'Новый чат', exact: true }).isVisible())) {
              await page.getByRole('link', { name: 'Все чаты', exact: true }).click();
            }

            await page.getByRole('button', { name: 'Новый чат', exact: true }).click();
          }
          if (name === 'chat-tablet-model') {
            await page.getByRole('button', { name: 'Модель: GPT-6', exact: true }).click();
            await page.getByRole('combobox', { name: 'Модель', exact: true })
              .selectOption('["claude","opus"]');
          }
          if (['chat-tablet-workspace', 'chat-tablet-transfer'].includes(name)) {
            await page.locator('.chat-folder').click();
            await page.getByRole('combobox', { name: 'Папка', exact: true }).selectOption('path');
            await page.getByRole('textbox', { name: 'Абсолютный путь на сервере', exact: true })
              .fill('/workspace/sample');

            if (name === 'chat-tablet-transfer') {
              await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
            }
          }
          if (name === 'chat-tablet-context') {
            await page.locator('.chat-context').click();
          }

          const issues = await page.evaluate(inspectFrame);

          // Именование модели — содержательная проверка: разрешённое многоточие само по себе
          // не доказывает читаемость шапки. Короткое синтетическое имя должно помещаться целиком.
          const modelLabel = page.locator('.chat-model .chat-selector-value');

          if (await modelLabel.count() && await modelLabel.innerText() === 'GPT-6') {
            const clipped = await modelLabel.evaluate((node) => node.scrollWidth > node.clientWidth + 1);

            if (clipped) {
              issues.push({ rule: 'model-name-clipped' });
            }
          }

          issues.push(
            ...errors.map((error) => ({
              rule: 'browser-error',
              error,
            })),
          );
          await page.screenshot({ path: path.join(directory, name + '.png') });

          // Чат стартует снизу: прежняя проверка дважды смотрела конец ленты и пропускала
          // начало. Проверяем также начало всех колонок и прокручиваемое тело диалога.
          await page.evaluate(() => {
            window.scrollTo(0, 0);

            for (const element of document.querySelectorAll('.pane-body,.mobile-dialog-body')) {
              element.scrollTop = 0;
            }
          });
          issues.push(...(await page.evaluate(inspectFrame)));
          await page.evaluate(scrollToEnd);
          issues.push(...(await page.evaluate(inspectFrame)));

          if (!(await page.locator('[role=dialog]').count())) {
            if (await page.evaluate(navCoversContent)) {
              issues.push({ rule: 'tabbar-covers-content' });
            }
          }

          report.push({
            name,
            size,
            width,
            height,
            fontScale,
            issues,
          });
          await context.close();
        }
      }

      console.log(name, report.filter((row) => row.name === name && row.issues.length).length);
    }

    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');

    const failures = report.filter((row) => row.issues.length);

    await writeFile(
      path.join(output, 'report.md'),
      '# Проверка мобильных экранов\n\n' +
        `Кадров: ${report.length}; с нарушениями: ${failures.length}.\n\n` +
        '| Сценарий | Размер | Шрифт | Нарушения |\n| --- | --- | --- | --- |\n' +
        failures
          .map(
            (row) =>
              `| ${row.name} | ${row.size} | ${row.fontScale} | ` +
              row.issues.map((issue) => issue.rule).join(', ') +
              ' |',
          )
          .join('\n') +
        '\n',
    );

    try {
      await execute('python3', ['-c', 'import PIL'], { timeout: 10000 });
    } catch {
      console.log('Листы обзора NOT RUN: Python/Pillow отсутствует');
      process.exitCode = failures.length ? 1 : 0;

      return;
    }

    await execute('python3', [path.join(root, 'tests/mobile/visual/contacts.py'), output], {
      timeout: 300000,
    });
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    server?.closeAllConnections();
    server?.close();
    await browser.close();
  }
}

await main();
