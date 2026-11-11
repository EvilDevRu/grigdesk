import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { directoryCleanupLockPath } from '../../shared/node/directoryLock.ts';
import { oldTree, present, treeSnapshot, waitFile } from '../helpers/deepseekRetentionFixture.mts';
import { down, menuTitle, sourceMenu } from './helpers/menuFixture.mts';
import { assertRestored, startPty } from './helpers/pty.mts';

type Cancellation = 'SIGINT' | 'SIGTERM' | 'raw-interrupt' | 'eof';

/**
 * Дочерний CLI останавливается на границе чтения либо после первого настоящего удаления.
 * Файловый барьер подтверждает приём отмены до продолжения текущей файловой операции.
 */
async function cancellationFixture(
  t: TestContext, mode: 'preview' | 'delete', json = false, menu = false,
) {
  const box = await sourceMenu(t);
  const artifacts = path.join(box.home, 'artifacts');
  const first = await oldTree(artifacts, 'aaa-first', 4096);
  const second = await oldTree(artifacts, 'zzz-second', 8192);
  const marker = path.join(box.home, 'cleanup-cancellation');
  const preload = path.join(box.home, 'cleanup-preload.mjs');

  await fs.writeFile(preload, `
import fs from 'node:fs/promises';
const readdir = fs.readdir.bind(fs);
const remove = fs.rm.bind(fs);
const exists = file => fs.lstat(file).then(() => true, () => false);
const marker = ${JSON.stringify(marker)};
let blocked = false;
process.on('SIGINT', () => fs.writeFile(marker + '.cancelled', ''));
process.on('SIGTERM', () => fs.writeFile(marker + '.cancelled', ''));
process.stdin.on('end', () => fs.writeFile(marker + '.cancelled', ''));
process.stdin.on('keypress', (_text, key) => {
  if (key.ctrl && key.name === 'c') {
    void fs.writeFile(marker + '.cancelled', '');
  }
});

/**
 * Текущий I/O сам по себе не отменяется; проверяется остановка перед следующим действием.
 * Маркеры находятся вне артефактов и не влияют на возраст и размеры кандидатов.
 */
async function barrier() {
  blocked = true;
  await fs.writeFile(marker + '.ready', '');

  while (!await exists(marker + '.release')) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

fs.readdir = async (...args) => {
  const result = await readdir(...args);

  if (${JSON.stringify(mode)} === 'preview' && !blocked
    && String(args[0]) === ${JSON.stringify(artifacts)}) {
    await barrier();
  }

  return result;
};
fs.rm = async (...args) => {
  const result = await remove(...args);

  if (${JSON.stringify(mode)} === 'delete' && !blocked
    && !await exists(${JSON.stringify(path.join(first, 'sentinel'))})
    && await exists(${JSON.stringify(path.join(second, 'sentinel'))})) {
    await barrier();
  }

  return result;
};
`);

  const session = startPty(t, {
    argv: [process.execPath, '--import', preload, path.join(box.root, 'cli/main.ts'),
      ...mode === 'delete' && !menu ? ['artifacts-cleanup', ...json ? ['--json'] : []] : []],
    env: {
      ...box.environment,
      GRIGDESK_ARTIFACTS_DIR: artifacts,
      LC_ALL: '',
      LC_MESSAGES: '',
      LANG: json ? 'en_US.UTF-8' : 'ru_RU.UTF-8',
      TERM: 'xterm-256color',
    },
  });

  return {
    artifacts,
    first,
    second,
    marker,
    session,
  };
}

/**
 * Сигналы, raw Ctrl+C и EOF доходят до того же CLI, который выполняет обход.
 * Продолжение I/O разрешается только после наблюдаемого события отмены в ребёнке.
 */
async function cancelAtBarrier(
  box: Awaited<ReturnType<typeof cancellationFixture>>,
  cancellation: Cancellation,
): Promise<void> {
  await waitFile(`${box.marker}.ready`);

  if (cancellation === 'eof') {
    box.session.endInput();
  } else if (cancellation === 'raw-interrupt') {
    box.session.write('\x03');
  } else {
    box.session.signal(cancellation);
  }

  await waitFile(`${box.marker}.cancelled`);
  await fs.writeFile(`${box.marker}.release`, '');
}

for (const cancellation of ['SIGINT', 'SIGTERM', 'raw-interrupt', 'eof'] as const) {
  test(`AC-CANCEL-PREVIEW: ${cancellation} завершает обход и восстанавливает терминал`, async (t) => {
    const box = await cancellationFixture(t, 'preview');
    const before = await treeSnapshot(box.artifacts);

    await box.session.wait(menuTitle);
    box.session.write(down.repeat(7) + '\r');
    await cancelAtBarrier(box, cancellation);

    const result = await box.session.done;

    assert.equal(result.code, cancellation === 'SIGTERM' ? 143 : cancellation === 'eof' ? 0 : 130);
    assertRestored(result, box.session.output());
    assert.deepEqual(await treeSnapshot(box.artifacts), before);
    assert.equal(await present(directoryCleanupLockPath(box.artifacts)), false);
  });
}

for (const variant of ['command', 'menu', 'json'] as const) {
  for (const cancellation of ['SIGINT', 'SIGTERM'] as const) {
    test(`AC-CANCEL-DELETE: ${cancellation}, ${variant} сохраняет оставшиеся каталоги`, async (t) => {
      const json = variant === 'json';
      const box = await cancellationFixture(t, 'delete', json, variant === 'menu');

      if (variant === 'menu') {
        await box.session.wait(menuTitle);
        box.session.write(down.repeat(7) + '\r');
        await box.session.wait(/Отмена|Cancel/u);
        box.session.write(down + '\r');
      }

      await cancelAtBarrier(box, cancellation);

      const result = await box.session.done;

      assert.equal(result.code, cancellation === 'SIGTERM' ? 143 : 130);
      assertRestored(result, box.session.output());
      assert.equal(await present(box.first), false);
      assert.equal(await present(box.second), true);
      assert.equal(await present(`${box.first}.lock`), false);
      assert.equal(await present(directoryCleanupLockPath(box.artifacts)), false);

      if (json) {
        const report = JSON.parse(box.session.output());
        const deleted = report.entries.filter((entry: { status: string }) => entry.status === 'deleted');

        assert.equal(report.interrupted, true);
        assert.equal(report.freedBytes, 4096);
        assert.equal(report.errorCount, 0);
        assert.equal(deleted.length, 1);
        assert.doesNotMatch(box.session.output(), /\x1b/u);
      } else {
        assert.match(box.session.output(), /Уборка прервана/u);
      }
    });
  }
}
