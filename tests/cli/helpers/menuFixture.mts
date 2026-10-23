import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSandbox } from './sandbox.mts';
import type { Sandbox } from './sandbox.mts';
import { startPty } from './pty.mts';

export const repository = fileURLToPath(new URL('../../../', import.meta.url));
export const menuTitle = /Что сделать\?|What (?:would you like to do|to do)\?/iu;
export const down = '\x1b[B';
export const up = '\x1b[A';

/**
 * Копирует новые общие модули из того же checkout, что проверяемый CLI.
 * Никакие каталоги данных владельца и внешние сервисы не используются.
 */
export async function sourceMenu(t: TestContext) {
  const box = await createSandbox(t);

  for (const name of ['server/src/app.ts', 'web/package.json', 'desktop/package.json']) {
    await mkdir(path.dirname(path.join(box.root, name)), { recursive: true });
    await writeFile(path.join(box.root, name), '{}\n');
  }

  for (const name of ['shared/node', 'shared/i18n']) {
    await cp(path.join(repository, name), path.join(box.root, name), { recursive: true });
  }

  box.installWindow();
  box.installRuntime();

  return box;
}

/**
 * Язык задаётся только переменными терминала, настройки окна здесь не участвуют.
 * Обе стороны PTY включены по умолчанию, отдельные барьеры отключают одну сторону.
 */
export function launchMenu(t: TestContext, box: Sandbox, overrides: NodeJS.ProcessEnv = {}) {
  return startPty(t, {
    argv: ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl')],
    env: {
      ...box.environment,
      LC_ALL: '',
      LC_MESSAGES: '',
      LANG: 'ru_RU.UTF-8',
      TERM: 'xterm-256color',
      ...overrides,
    },
  });
}

/**
 * Выбор идёт настоящими стрелками от первого пункта текущего уровня.
 * Сначала дожидаемся экрана, чтобы ввод не был потерян до включения raw mode.
 */
export async function enterGroup(session: ReturnType<typeof startPty>, index: number, pattern: RegExp) {
  await session.wait(menuTitle);

  const before = session.output().length;

  session.write(down.repeat(index) + '\r');
  await session.wait(pattern, 4000, before);
}

/**
 * Отсутствие нового API превращается в assertion о поведении внутри теста.
 * Ошибки импортов существующего файла не перехватываются и не выдаются за RED.
 */
export async function requiredApi(relative: string, symbol: string): Promise<any> {
  const target = new URL(relative, new URL('../../../', import.meta.url));
  const exists = await readFile(target).then(() => true, (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, 'ENOENT');

    return false;
  });

  assert.ok(exists, `Не реализовано поведение плана: ${relative} / ${symbol}`);

  const module = await import(target.href);

  assert.equal(typeof module[symbol], 'function', `Не реализован ${symbol}`);

  return module[symbol];
}

/**
 * Внешние ANSI удаляются перед измерением ширины отображаемых строк.
 * Перерисовки по CR считаются отдельными строками, а не одной длинной записью.
 */
export function visibleLines(output: string): string[] {
  return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split(/[\r\n]/u);
}

/**
 * Закрывает результат и его родительские уровни по одному, дожидаясь перерисовки.
 * Возврат в подменю либо сразу в корень не влияет на проверяемую команду.
 */
export async function exitMenus(session: ReturnType<typeof startPty>) {
  for (let level = 0; level < 4 && !session.finished(); level++) {
    const before = session.output().length;
    const deadline = Date.now() + 2000;

    session.write('\x1b');

    while (!session.finished() && session.output().length === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  return session.done;
}
