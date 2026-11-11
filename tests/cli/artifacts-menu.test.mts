import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { cliTranslator } from '../../cli/i18n.ts';
import { buildHelper } from '../../server/scripts/sea/helpers.mts';
import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';
import {
  down, exitMenus, menuTitle, repository, sourceMenu, visibleLines,
} from './helpers/menuFixture.mts';
import { assertRestored, startPty } from './helpers/pty.mts';
import { completed } from './helpers/sandbox.mts';
import { DAY, oldTree, present, treeSnapshot } from '../helpers/deepseekRetentionFixture.mts';

const cleanupTitle = /Уборка артефактов|Artifacts? cleanup|Clean(?:up)? artifacts/iu;
const choice = /Отмена|Отменить|Cancel/iu;
const deletion = /Удалить|Delete/iu;

/**
 * Меню запускается в настоящем PTY только с приватной папкой артефактов.
 * Перед стрелками проверяется видимый пункт, поэтому база краснеет по отсутствию функции.
 */
async function menuFixture(t: TestContext, locale: string, columns = 80, term = 'dumb') {
  const box = await sourceMenu(t);
  const artifacts = path.join(box.home, 'artifacts');
  const old = await oldTree(artifacts, 'old', 4096);
  const young = await oldTree(artifacts, 'young', 17, Date.now() - 6 * DAY);
  const session = startPty(t, {
    argv: ['bash', path.join(box.root, 'bin/grigdesk-ctl')],
    env: {
      ...box.environment,
      GRIGDESK_ARTIFACTS_DIR: artifacts,
      LC_ALL: '',
      LC_MESSAGES: '',
      LANG: locale,
      TERM: term,
      NO_COLOR: '1',
    },
    columns,
    rows: 40,
  });

  await session.wait(menuTitle);
  await session.wait(cleanupTitle);

  const before = session.output().length;

  session.write(down.repeat(7) + '\r');
  await session.wait(choice, 4000, before);
  await session.wait(deletion, 4000, before);

  return {
    box,
    artifacts,
    old,
    young,
    session,
    before,
  };
}

/**
 * Preview и результат могут использовать любую принятую единицу размера.
 * Число 4096 байт либо его точное двоичное представление остаётся наблюдаемым.
 */
function assertPreview(output: string, artifacts: string) {
  assert.ok(output.includes(artifacts), 'Preview должен показать выбранный root');
  assert.match(output, /old/u);
  assert.match(output, /4\s?096|4(?:[.,]\d+)?\s*(?:KiB|КиБ|KB|КБ)/iu);
  assert.match(output, /7/u, 'Порог по умолчанию должен быть виден');
  assert.match(output, /3/u, 'K по умолчанию должен быть виден');
}

for (const locale of ['ru_RU.UTF-8', 'en_US.UTF-8']) {
  for (const cancellation of ['enter', 'escape', 'eof', 'interrupt', 'terminate'] as const) {
    test(`AM-CONFIRM: ${locale}, отмена ${cancellation} сохраняет old и termios`, async (t) => {
      const { artifacts, old, session, before } = await menuFixture(t, locale);

      assertPreview(session.output().slice(before), artifacts);
      assert.equal(await present(old), true);

      const snapshot = await treeSnapshot(artifacts);

      const cancelledAt = session.output().length;

      if (cancellation === 'interrupt' || cancellation === 'terminate') {
        session.signal(cancellation === 'interrupt' ? 'SIGINT' : 'SIGTERM');
      } else if (cancellation === 'eof') {
        session.endInput();
      } else {
        session.write(cancellation === 'enter' ? '\r' : '\x1b');
      }

      if (cancellation === 'enter' || cancellation === 'escape') {
        await session.wait(menuTitle, 4000, cancelledAt);
      }

      const result = cancellation === 'enter' || cancellation === 'escape'
        ? await exitMenus(session) : await session.done;

      assert.equal(result.code, cancellation === 'interrupt' ? 130 : cancellation === 'terminate' ? 143 : 0);
      assertRestored(result, session.output());
      assert.deepEqual(await treeSnapshot(artifacts), snapshot);
    });
  }

  test(`AM-CONFIRM: ${locale}, явное удаление сохраняет young и показывает результат`, async (t) => {
    const { artifacts, old, young, session, before } = await menuFixture(t, locale);

    assertPreview(session.output().slice(before), artifacts);
    assert.equal(await present(old), true);

    const confirmed = session.output().length;

    session.write(down + '\r');
    await session.wait(/удалено|deleted|freed|освобождено/iu, 4000, confirmed);
    assert.equal(await present(old), false);
    assert.equal(await present(young), true);
    assert.equal(session.finished(), false, 'Результат остаётся до Enter/Esc');

    const result = await exitMenus(session);

    assert.equal(result.code, 0);
    assertRestored(result, session.output());
  });
}

test('AM-RECHECK: настоящий lock после preview сохраняет old и чужой token', async (t) => {
  const { old, session } = await menuFixture(t, 'ru_RU.UTF-8');
  const lock = await acquireDirectoryLock(`${old}.lock`, { waitMs: 0 });

  t.after(() => lock.release());

  const owner = await readFile(`${old}.lock/owner.json`, 'utf8');
  const before = session.output().length;

  session.write(down + '\r');
  await session.wait(/занят|блокиров|locked|busy/iu, 4000, before);
  assert.equal(await present(old), true);
  assert.equal(await readFile(`${old}.lock/owner.json`, 'utf8'), owner);

  const result = await exitMenus(session);

  assert.equal(result.code, 0);
  assertRestored(result, session.output());
});

for (const locale of ['ru_RU.UTF-8', 'en_US.UTF-8']) {
  for (const columns of [40, 80]) {
    for (const term of ['dumb', 'xterm-256color']) {
      test(`AM-WIDTH: ${locale}, ${columns}, ${term}/NO_COLOR — preview и результат`, async (t) => {
        const { old, session, before } = await menuFixture(t, locale, columns, term);
        const output = session.output().slice(before);

        assert.match(output, /old/u);
        assert.match(output, choice);
        assert.match(output, deletion);
        assert.doesNotMatch(output, /\x1b\[[0-9;]*m/u);

        for (const line of visibleLines(output)) {
          assert.ok([...line].length <= columns, `Строка шире ${columns}: ${line}`);
        }

        const confirmed = session.output().length;

        session.write(down + '\r');
        await session.wait(/удалено|deleted|freed|освобождено/iu, 4000, confirmed);

        const resultOutput = session.output().slice(confirmed);

        assert.doesNotMatch(resultOutput, /\x1b\[[0-9;]*m/u);

        for (const line of visibleLines(resultOutput)) {
          assert.ok([...line].length <= columns, `Строка результата шире ${columns}: ${line}`);
        }

        assert.equal(await present(old), false);

        const result = await exitMenus(session);

        assert.equal(result.code, 0);
        assertRestored(result, session.output());
      });
    }
  }
}

test('AM-WIDTH: пустой root показывает нули без выдуманных кандидатов', async (t) => {
  const box = await sourceMenu(t);
  const artifacts = path.join(box.home, 'empty-artifacts');

  await mkdir(artifacts);

  const beforeTree = await treeSnapshot(artifacts);
  const session = startPty(t, {
    argv: ['bash', path.join(box.root, 'bin/grigdesk-ctl')],
    env: {
      ...box.environment,
      GRIGDESK_ARTIFACTS_DIR: artifacts,
      TERM: 'dumb',
      NO_COLOR: '1',
    },
  });

  await session.wait(menuTitle);
  await session.wait(cleanupTitle);

  const before = session.output().length;

  session.write(down.repeat(7) + '\r');
  await session.wait(/(?:^|\s|:)0(?:[.,]0+)?(?:\s|$)/u, 4000, before);

  const result = await exitMenus(session);

  assert.equal(result.code, 0);
  assertRestored(result, session.output());
  assert.deepEqual(await treeSnapshot(artifacts), beforeTree);
});

test('AM-WIDTH: ошибка preview не предлагает удаление и возвращает ненулевой результат', async (t) => {
  const box = await sourceMenu(t);
  const artifacts = path.join(box.home, 'not-directory');

  await writeFile(artifacts, 'private sentinel');

  const session = startPty(t, {
    argv: ['bash', path.join(box.root, 'bin/grigdesk-ctl')],
    env: {
      ...box.environment,
      GRIGDESK_ARTIFACTS_DIR: artifacts,
      TERM: 'dumb',
      NO_COLOR: '1',
    },
  });

  await session.wait(menuTitle);
  await session.wait(cleanupTitle);

  const before = session.output().length;

  session.write(down.repeat(7) + '\r');
  await session.wait(/ошиб|error|каталог|directory/iu, 4000, before);
  assert.doesNotMatch(session.output().slice(before), /›[^\r\n]*(?:Удалить|Delete)/iu);

  const result = await exitMenus(session);

  assert.notEqual(result.code, 0, session.output());
  assert.equal(await readFile(artifacts, 'utf8'), 'private sentinel');
  assertRestored(result, session.output());
});

for (const kind of ['portable', 'release', 'installed']) {
  for (const locale of ['ru_RU.UTF-8', 'en_US.UTF-8']) {
    test(`AM-PACKAGED: ${kind}/${locale}, перенос helper и меню группы разработчика`, async (t) => {
      const box = await sourceMenu(t);
      const initial = path.join(box.home, 'initial-runtime');
      const moved = path.join(box.home, 'moved-runtime');
      const artifacts = path.join(box.home, 'private-artifacts');

      await oldTree(artifacts, 'old', 4096);
      await buildHelper({
        root: repository,
        manifestPath: path.join(repository, 'server/build/helpers.json'),
        id: 'grigdesk-cli',
        outDir: path.join(initial, 'server/runtime/helpers'),
        workDir: path.join(box.home, 'helper-work'),
      });
      await cp(path.join(box.root, 'VERSION'), path.join(initial, 'VERSION'));
      await mkdir(path.join(initial, 'bin'), { recursive: true });

      if (kind === 'portable') {
        await writeFile(path.join(initial, 'bin/bundle.json'), JSON.stringify({ format: 1, kind }));
      } else if (kind === 'release') {
        await writeFile(path.join(initial, 'release.json'), '{}');
      }

      await rename(initial, moved);

      const entry = path.join(moved, 'server/runtime/helpers/grigdesk-cli.mjs');
      const environment = {
        ...box.environment,
        GRIGDESK_ARTIFACTS_DIR: artifacts,
        LC_ALL: '',
        LC_MESSAGES: '',
        LANG: locale,
        TERM: 'dumb',
      };
      const session = startPty(t, {
        argv: [process.execPath, entry],
        env: environment,
        cwd: '/',
      });

      await session.wait(menuTitle);
      await session.wait(cleanupTitle);

      const { t: translate } = cliTranslator(environment);
      const output = session.output();

      assert.ok(output.indexOf(translate('menuGroups.developer')) >= 0);
      assert.ok(output.indexOf(translate('menuGroups.developer'))
        < output.indexOf(translate('artifactsCleanup')));
      assert.doesNotMatch(output, /Сборка|Разработка|Development|Build ›/iu);
      session.write(down.repeat(5) + '\r');
      await session.wait(choice);

      const before = await treeSnapshot(artifacts);
      const result = await exitMenus(session);

      assert.equal(result.code, 0);
      assertRestored(result, session.output());

      const child = spawn(process.execPath, [entry, 'artifacts-cleanup', '--dry-run', '--json'], {
        cwd: '/',
        env: environment,
      });
      const command = await completed(child);

      assert.equal(command.code, 0, command.stderr);
      assert.equal(JSON.parse(command.stdout).wouldDeleteBytes, 4096);
      assert.doesNotMatch(command.stdout, /\x1b/u);
      assert.deepEqual(await treeSnapshot(artifacts), before);
    });
  }
}
