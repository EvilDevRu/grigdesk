import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * Запускает штатный wrapper вокруг подставного Go-сборщика.
 * Корень с пробелами и журнал находятся в отдельном временном каталоге.
 */
function sandbox(t, buildCode = 0) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'grigdesk relay script '));
  const tools = path.join(root, 'tools');
  const journal = path.join(root, 'calls');
  const wrapper = path.join(tools, 'relay');

  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(tools);
  copyFileSync(new URL('../../tools/relay', import.meta.url), wrapper);
  writeFileSync(journal, '');
  writeFileSync(path.join(tools, 'build-go-utilities.sh'), [
    'printf "%s\\n" "$@" > "$RELAY_TEST_LOG"',
    'exit "$RELAY_TEST_BUILD_CODE"',
  ].join('\n'));

  return {
    root,
    calls: () => readFileSync(journal, 'utf8'),
    run: (args) => spawnSync('/bin/bash', [wrapper, ...args], {
      cwd: '/',
      env: {
        HOME: root,
        PATH: '/usr/bin:/bin',
        RELAY_TEST_LOG: journal,
        RELAY_TEST_BUILD_CODE: String(buildCode),
      },
      encoding: 'utf8',
      timeout: 10000,
    }),
  };
}

test('RL-46: неверные аргументы завершаются до сборки', (t) => {
  const box = sandbox(t);

  for (const args of [[], ['install'], ['build', 'extra']]) {
    const result = box.run(args);

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Использование: tools\/relay build/);
    assert.equal(box.calls(), '');
  }
});

for (const code of [0, 3]) {
  test(`RL-47/48: Go-сборщик получает bin/utilities своей копии, код ${code} сохраняется`, (t) => {
    const box = sandbox(t, code);
    const result = box.run(['build']);

    assert.equal(result.status, code, result.stderr);
    assert.equal(box.calls(), path.join(box.root, 'bin/utilities') + '\n');
  });
}
