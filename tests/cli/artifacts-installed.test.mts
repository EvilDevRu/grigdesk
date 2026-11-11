import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { cliTranslator } from '../../cli/i18n.ts';
import { installedFixture, pinnedKeyHook } from '../helpers/installedUpdateFixture.mjs';
import { oldTree, present } from '../helpers/deepseekRetentionFixture.mts';
import { down } from './helpers/menuFixture.mts';
import { assertRestored, startPty } from './helpers/pty.mts';

/**
 * Новый installed entry проверяется отдельно от прежнего собранного source CLI.
 * Сервер и сайт не нужны: receipt приватный, проверка обновлений остаётся ожидающим Promise.
 */
async function fixture(t: TestContext, language = 'ru_RU.UTF-8', argv: string[] = []) {
  const box = await installedFixture(t, { mode: 'server' });
  const hook = await pinnedKeyHook(box.temporary, box.release.publicKeyPem);
  const artifacts = path.join(box.temporary, 'artifacts');
  const old = await oldTree(artifacts, 'old', 4096);
  const entry = path.join(box.temporary, 'installed-cleanup.mjs');
  const cliUrl = new URL('../../cli/installedCli.ts', import.meta.url).href;

  await fs.writeFile(entry, [
    'globalThis.fetch = async () => new Promise(() => {});',
    `const { runInstalledCli } = await import(${JSON.stringify(cliUrl)});`,
    `process.exitCode = await runInstalledCli(${JSON.stringify(box.root)}, ${JSON.stringify(argv)});`,
  ].join('\n'));

  const env = {
    HOME: box.temporary,
    GRIGDESK_HOME: path.join(box.temporary, 'data'),
    GRIGDESK_ARTIFACTS_DIR: artifacts,
    PATH: '/usr/bin:/bin',
    LC_ALL: '',
    LC_MESSAGES: '',
    LANG: language,
    TERM: 'dumb',
  };
  const session = startPty(t, {
    argv: [process.execPath, '--import', hook, entry],
    env,
    cwd: box.temporary,
  });

  return {
    box,
    old,
    session,
    env,
  };
}

for (const language of ['ru_RU.UTF-8', 'en_US.UTF-8']) {
  for (const remove of [false, true]) {
    test(`AI-MENU: installed ${language}, явное удаление=${remove}`, async (t) => {
      const { box, old, session, env } = await fixture(t, language);
      const { t: translate } = cliTranslator(env);

      await session.wait(/GrigDesk 0\.2\.0.*release/u);
      assert.ok(session.output().includes(translate('menuGroups.developer')));
      assert.ok(session.output().includes(translate('artifactsCleanup')));
      session.write(down.repeat(9) + '\r');
      await session.wait(/Отмена|Cancel/u);
      assert.equal(await present(old), true);

      const before = session.output().length;

      session.write(remove ? down + '\r' : '\r');

      if (remove) {
        await session.wait(/4096/u, 4000, before);
        assert.ok(session.output().slice(before).includes(translate('screens.running')),
          'После подтверждения показано выполнение, а не прежний вопрос об удалении');
        assert.equal(await present(old), false);
        session.write('\r');
      }

      await session.wait(/GrigDesk 0\.2\.0.*release/u, 4000, before);
      session.write('\x1b');

      const result = await session.done;

      assert.equal(result.code, 0, session.output());
      assert.equal(await present(old), !remove);
      assertRestored(result, session.output());
      await box.preserved();
    });
  }
}

test('AI-JSON: installed ctl выполняет локальный dry-run и сохраняет один JSON', async (t) => {
  const { old, session } = await fixture(t, 'en_US.UTF-8', ['artifacts-cleanup', '--dry-run', '--json']);
  const result = await session.done;
  const report = JSON.parse(session.output());

  assert.equal(result.code, 0, session.output());
  assert.equal(report.wouldDeleteBytes, 4096);
  assert.equal(report.freedBytes, 0);
  assert.equal(await present(old), true);
  assertRestored(result, session.output());
});
