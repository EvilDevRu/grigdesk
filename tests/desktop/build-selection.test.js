import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as selection from '../../server/src/lib/builtServerSelection.ts';
import { processStarttime } from '../../server/src/lib/dataHomeBoot.ts';
import { selectSeaServer } from '../../server/src/lib/selectSeaServer.ts';
import { loadServerRuntime } from '../../desktop/src/runtimeConfig.ts';

/**
 * Настоящие descriptor, блокировки и ELF-заглушка принадлежат временному каталогу.
 * Порт verify заменяется: установка и сервер этой машины никогда не запускаются.
 */
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-build-selection-'));
  const root = path.join(directory, 'source with spaces');
  const home = path.join(directory, 'home');
  const data = path.join(directory, 'data');
  const env = {
    HOME: home,
    XDG_DATA_HOME: path.join(directory, 'xdg'),
    GRIGDESK_HOME: data,
  };
  const file = path.join(env.XDG_DATA_HOME, 'grigdesk/desktop/runtime.json');
  const binary = path.join(root, 'bin/grigdesk-server');
  const descriptor = {
    version: 4,
    kind: 'binary',
    binary: path.join(root, 'release/bin/grigdesk-server'),
    home: data,
    cliPaths: ['/user/node/bin'],
  };
  const previous = JSON.stringify(descriptor);
  let verifications = 0;

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  for (const folder of [home, data, path.dirname(file), path.dirname(binary)]) {
    await fs.mkdir(folder, { recursive: true });
  }

  await fs.writeFile(binary, '\x7fELF-fixture', { mode: 0o755 });
  await fs.writeFile(file, previous, { mode: 0o600 });
  await fs.writeFile(path.join(path.dirname(file), 'runtime-version'), '4\n');

  return {
    root,
    home,
    env,
    file,
    binary,
    data,
    descriptor,
    previous,
    input: {
      root,
      home,
      env,
    },
    apply: {
      home,
      env,
      verifyBinary: async () => {
        verifications += 1;
      },
    },
    verifications: () => verifications,
  };
}

test('полная сборка откладывает выбор при живом сервере и применяет его перед новым запуском', async (t) => {
  assert.equal(typeof selection.queueBuiltServer, 'function', 'Нет отложенной привязки полной сборки');
  assert.equal(typeof selection.applyBuiltServer, 'function', 'Нет применения привязки перед запуском');

  const box = await fixture(t);
  const lock = path.join(box.data, 'state/server.lock');

  await fs.mkdir(path.dirname(lock));
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, starttime: processStarttime(process.pid) }));

  assert.equal(await selection.queueBuiltServer(box.input), 'queued');
  assert.equal(await fs.readFile(box.file, 'utf8'), box.previous);
  assert.equal(await selection.applyBuiltServer(box.apply), false);
  assert.equal(box.verifications(), 0);
  assert.equal(await fs.readFile(box.file, 'utf8'), box.previous);

  await fs.rm(lock);

  assert.equal(await selection.applyBuiltServer(box.apply), true);
  assert.deepEqual(JSON.parse(await fs.readFile(box.file, 'utf8')), {
    ...box.descriptor,
    binary: box.binary,
  });
  assert.equal(await fs.readFile(`${box.file}.previous`, 'utf8'), box.previous);
  assert.equal(box.verifications(), 1);
  await assert.rejects(fs.stat(`${box.file}.build-selection`), { code: 'ENOENT' });
  assert.equal(await selection.applyBuiltServer(box.apply), false);
});

test('очередь ограничена своей установкой и той же папкой данных, текущий ELF уже выбран', async (t) => {
  for (const change of [
    { binary: '/other/bin/grigdesk-server' },
    { home: '/other/data' },
    { binary: 'current' },
  ]) {
    const box = await fixture(t);
    const descriptor = {
      ...box.descriptor,
      ...change,
      ...change.binary === 'current' ? { binary: box.binary } : {},
    };
    const text = JSON.stringify(descriptor);

    await fs.writeFile(box.file, text);

    const expected = change.binary === 'current' ? 'current' : 'foreign';

    assert.equal(await selection.queueBuiltServer(box.input), expected);
    assert.equal(await fs.readFile(box.file, 'utf8'), text);
    await assert.rejects(fs.stat(`${box.file}.build-selection`), { code: 'ENOENT' });
  }
});

test('source и прежний SEA этой копии переходят на ELF с сохранением Node в cliPaths', async (t) => {
  for (const version of [1, 2, 3]) {
    const box = await fixture(t);
    const descriptor = version === 3 ? {
      version,
      kind: 'sea',
      root: path.join(box.root, 'release'),
      home: box.data,
    } : {
      version,
      root: box.root,
      node: process.execPath,
      ...version === 2 ? { home: box.data } : {},
    };

    await fs.writeFile(box.file, JSON.stringify(descriptor));

    assert.equal(await selection.queueBuiltServer(box.input), 'queued');
    assert.equal(await selection.applyBuiltServer(box.apply), true);

    const next = JSON.parse(await fs.readFile(box.file, 'utf8'));

    assert.equal(next.binary, box.binary);
    assert.equal(next.home, box.data);
    assert.deepEqual(next.cliPaths, version === 3 ? [] : [path.dirname(process.execPath)]);
  }
});

test('явный новый выбор отменяет очередь; внешняя смена primary не перезаписывается', async (t) => {
  for (const explicit of [false, true]) {
    const box = await fixture(t);

    await selection.queueBuiltServer(box.input);

    if (explicit) {
      await selectSeaServer({
        root: box.binary,
        home: box.home,
        env: box.env,
        verifyBinary: box.apply.verifyBinary,
      });
    } else {
      await fs.writeFile(box.file, JSON.stringify({ ...box.descriptor, binary: '/other/bin/server' }));
    }

    const chosen = await fs.readFile(box.file, 'utf8');

    assert.equal(await selection.applyBuiltServer(box.apply), false);
    assert.equal(await fs.readFile(box.file, 'utf8'), chosen);
    await assert.rejects(fs.stat(`${box.file}.build-selection`), { code: 'ENOENT' });
  }
});

test('изменение установленного ELF или отказ verify сохраняют прежнюю привязку и очередь', async (t) => {
  for (const reason of ['changed', 'verify', 'during-verify']) {
    const box = await fixture(t);

    await selection.queueBuiltServer(box.input);

    if (reason === 'changed') {
      await fs.appendFile(box.binary, 'другая сборка');
    } else {
      box.apply.verifyBinary = async () => {
        if (reason === 'verify') {
          throw new Error('verify отказал');
        }

        await fs.appendFile(box.binary, 'смена во время verify');
      };
    }

    await assert.rejects(selection.applyBuiltServer(box.apply), { code: 'server_selection_build_failed' });
    assert.equal(await fs.readFile(box.file, 'utf8'), box.previous);
    await fs.stat(`${box.file}.build-selection`);
    await assert.rejects(fs.stat(`${box.file}.previous`), { code: 'ENOENT' });
  }
});

test('обрыв после backup или primary восстанавливается общим журналом выбора', async (t) => {
  for (const interrupted of ['backup', 'primary']) {
    const box = await fixture(t);

    await selection.queueBuiltServer(box.input);

    await assert.rejects(selection.applyBuiltServer({
      ...box.apply,
      select: (input) => selectSeaServer({
        ...input,
        afterRename: async (phase) => {
          if (phase === interrupted) {
            throw new Error('прерывание');
          }
        },
      }),
    }), { code: 'server_selection_build_failed' });

    assert.equal(await selection.applyBuiltServer(box.apply), interrupted === 'backup');
    assert.equal(JSON.parse(await fs.readFile(box.file, 'utf8')).binary, box.binary);
    assert.equal(await fs.readFile(`${box.file}.previous`, 'utf8'), box.previous);
    await assert.rejects(fs.stat(`${box.file}.transaction`), { code: 'ENOENT' });
    await assert.rejects(fs.stat(`${box.file}.build-selection`), { code: 'ENOENT' });
  }
});

test('повреждённая очередь и смена намерения во время verify не меняют primary', async (t) => {
  for (const reason of ['json', 'mode', 'link', 'race']) {
    const box = await fixture(t);
    const pending = `${box.file}.build-selection`;

    await selection.queueBuiltServer(box.input);

    if (reason === 'json') {
      await fs.writeFile(pending, '{');
    } else if (reason === 'mode') {
      await fs.chmod(pending, 0o644);
    } else if (reason === 'link') {
      await fs.rename(pending, `${pending}.saved`);
      await fs.symlink(`${pending}.saved`, pending);
    } else {
      box.apply.verifyBinary = async () => {
        await fs.appendFile(pending, '\n');
      };
    }

    await assert.rejects(selection.applyBuiltServer(box.apply), { code: 'server_selection_build_failed' });
    assert.equal(await fs.readFile(box.file, 'utf8'), box.previous);
  }
});

test('загрузчик применяет намерение до первого чтения descriptor и явно сообщает отказ', async () => {
  const calls = [];
  const base = {
    env: {},
    home: '/test/home',
    purpose: 'inspect',
    deps: {
      async applyBuildSelection() {
        calls.push('apply');
      },
      async readText() {
        calls.push('read');

        return null;
      },
    },
  };

  await loadServerRuntime(base);

  assert.deepEqual(calls, ['apply', 'read']);
  calls.length = 0;
  base.deps.applyBuildSelection = async () => {
    throw Object.assign(new Error('не удалось'), { code: 'server_selection_build_failed' });
  };

  const result = await loadServerRuntime(base);

  assert.equal(result.problem, 'invalid');
  assert.match(result.message, /server_selection_build_failed/);
  assert.deepEqual(calls, []);
});

test('смена GRIGDESK_HOME у source v1 после сборки отменяет намерение без смены папки данных', async (t) => {
  const box = await fixture(t);
  const previous = JSON.stringify({
    version: 1,
    root: box.root,
    node: process.execPath,
  });

  await fs.writeFile(box.file, previous);
  await selection.queueBuiltServer(box.input);

  assert.equal(await selection.applyBuiltServer({
    ...box.apply,
    env: { ...box.env, GRIGDESK_HOME: path.join(box.home, 'other-data') },
  }), false);
  assert.equal(await fs.readFile(box.file, 'utf8'), previous);
  assert.equal(box.verifications(), 0);
  await assert.rejects(fs.stat(`${box.file}.build-selection`), { code: 'ENOENT' });
});
