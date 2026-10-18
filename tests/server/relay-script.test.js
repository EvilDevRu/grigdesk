import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

/**
 * Копирует только CLI и общую проверку Node в отдельный root с пробелами.
 * Фальшивый npm записывает argv и код сборки, не устанавливая зависимости.
 */
function sandbox(t, { dependencies = false, buildCode = 0 } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-relay-script-'));
  const root = path.join(directory, 'копия проекта');
  const home = path.join(directory, 'Домашняя папка');
  const commands = path.join(directory, 'команды');
  const nodeDir = path.join(directory, 'Node каталог');
  const journal = path.join(directory, 'npm.jsonl');

  t.after(() => rmSync(directory, {
    recursive: true,
    force: true,
  }));

  for (const name of [path.join(root, 'deploy/lib'), path.join(root, 'tools'), path.join(root, 'relay'),
    home, commands, nodeDir]) {
    mkdirSync(name, { recursive: true });
  }

  for (const name of ['tools/relay', 'deploy/lib/runtime-env.sh']) {
    if (existsSync(path.join(repository, name))) {
      copyFileSync(path.join(repository, name), path.join(root, name));
    }
  }

  for (const command of ['dirname', 'env']) {
    symlinkSync('/usr/bin/' + command, path.join(commands, command));
  }

  writeFileSync(path.join(nodeDir, 'node'), `#!/bin/bash\nexec ${quote(process.execPath)} "$@"\n`, {
    mode: 0o755,
  });
  writeFileSync(path.join(commands, 'npm'), `#!/bin/bash
set -e
"$RELAY_TEST_NODE" -e '
  const fs = require("node:fs");
  fs.appendFileSync(process.env.RELAY_TEST_LOG, JSON.stringify({
    args: process.argv.slice(1),
    nodeEnv: process.env.NODE_ENV,
  }) + "\\n");
' -- "$@"
if [[ "$*" == *"run build"* ]]; then
  exit "$RELAY_TEST_BUILD_CODE"
fi
`, { mode: 0o755 });
  writeFileSync(path.join(root, '.env'), 'НЕ_ЧИТАТЬ=$(exit 71)\n');

  if (dependencies) {
    for (const name of ['esbuild', 'postject']) {
      mkdirSync(path.join(root, 'relay/node_modules', name), { recursive: true });
    }
  }

  const run = (args) => spawnSync('/bin/bash', [path.join(root, 'tools/relay'), ...args], {
    env: {
      PATH: commands,
      HOME: home,
      GRIGDESK_NODE_DIR: nodeDir,
      RELAY_TEST_NODE: process.execPath,
      RELAY_TEST_LOG: journal,
      RELAY_TEST_BUILD_CODE: String(buildCode),
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  const calls = () => existsSync(journal)
    ? readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];

  return {
    root,
    run,
    calls,
  };
}

test('RL-46: использование без обращения к npm', (t) => {
  for (const args of [[], ['install'], ['build', 'extra']]) {
    const box = sandbox(t);
    const result = box.run(args);

    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stderr, 'использование: tools/relay build\n');
    assert.deepEqual(box.calls(), []);
  }
});

test('RL-47: зависимости ставятся только при отсутствии', (t) => {
  for (const dependencies of [false, true]) {
    const box = sandbox(t, { dependencies });
    const result = box.run(['build']);

    assert.equal(result.status, 0, result.stderr);

    const calls = box.calls();
    const prefix = ['--prefix', path.join(box.root, 'relay')];

    assert.deepEqual(calls.map((call) => call.args), dependencies
      ? [[...prefix, 'run', 'build']]
      : [[...prefix, 'ci', '--include=dev', '--no-audit', '--no-fund'], [...prefix, 'run', 'build']]);

    if (!dependencies) {
      assert.equal(calls[0].nodeEnv, 'development');
    }
  }
});

test('RL-48: код сборки передаётся наружу', (t) => {
  const box = sandbox(t, {
    dependencies: true,
    buildCode: 3,
  });
  const result = box.run(['build']);

  assert.equal(result.status, 3, result.stderr);
  assert.equal(box.calls().length, 1);
});
