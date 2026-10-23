import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * Новый модуль обязан существовать прежде проверки файловых эффектов.
 * До реализации это предметный RED, без необработанного MODULE_NOT_FOUND.
 */
async function integrationApi() {
  const target = new URL('../../desktop/src/portableIntegration.ts', import.meta.url);
  const present = await fs.stat(target).then(() => true, (error) => {
    assert.equal(error.code, 'ENOENT');

    return false;
  });

  assert.ok(present, 'К10: одноразовое предложение меню для portable ещё не реализовано');

  const api = await import(target.href);

  assert.equal(typeof api.offerPortableIntegration, 'function');

  return api.offerPortableIntegration;
}

/**
 * userData, XDG и оба окна принадлежат фикстуре; никакого Electron или настоящего меню.
 * Порт внешних команд запрещает sudo/apt/systemctl, ответ native-диалога внедрён явно.
 */
async function fixture(t, answer = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-menu-'));
  const home = path.join(root, 'home');
  const userData = path.join(root, 'userData');
  const xdg = path.join(root, 'xdg');
  const settings = path.join(userData, 'settings.json');
  const descriptor = path.join(xdg, 'grigdesk/desktop/runtime.json');
  const errors = [];
  const questions = [];

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const directory of [home, userData, xdg, path.dirname(descriptor)]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }

  await fs.writeFile(settings, 'прежние настройки');
  await fs.writeFile(descriptor, 'прежний выбор сервера');

  const options = {
    isPortable: true,
    windowPath: path.join(root, 'copy A/GrigDesk'),
    userData,
    home,
    env: { HOME: home, XDG_DATA_HOME: xdg },
    shown: Promise.resolve(),
    ask: async () => {
      questions.push(options.windowPath);

      return answer;
    },
    reportError: (error) => {
      errors.push(error);
    },
    run: async () => assert.fail('установка пакетов/служб не входит в предложение меню'),
    fs,
  };

  await fs.mkdir(path.dirname(options.windowPath), { recursive: true });
  await fs.writeFile(options.windowPath, 'физический AppImage фикстуры', { mode: 0o755 });

  return {
    root,
    home,
    xdg,
    userData,
    options,
    errors,
    questions,
    entry: path.join(xdg, 'applications/grigdesk-portable.desktop'),
    async unchanged() {
      assert.equal(await fs.readFile(settings, 'utf8'), 'прежние настройки');
      assert.equal(await fs.readFile(descriptor, 'utf8'), 'прежний выбор сервера');
    },
  };
}

test('PB-MENU-01: yes после показа, одна запись 0600 и повтор без вопроса', {
  timeout: 5000,
}, async (t) => {
  const box = await fixture(t);
  const offer = await integrationApi();
  let reveal;

  box.options.shown = new Promise((resolve) => {
    reveal = resolve;
  });

  await offer({ ...box.options, isPortable: false });
  assert.equal(box.questions.length, 0);
  assert.deepEqual(await fs.readdir(box.userData), ['settings.json']);

  const offering = offer(box.options);

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(box.questions.length, 0);
  } finally {
    reveal();
  }

  await offering;
  assert.equal(box.questions.length, 1);
  assert.match(await fs.readFile(box.entry, 'utf8'), /Type=Application/u);

  const markers = (await fs.readdir(box.userData)).filter((name) => name !== 'settings.json');

  assert.equal(markers.length, 1);
  assert.equal((await fs.stat(path.join(box.userData, markers[0]))).mode & 0o777, 0o600);

  const anotherWindow = path.join(box.root, 'copy B/GrigDesk');

  await fs.mkdir(path.dirname(anotherWindow), { recursive: true });
  await fs.writeFile(anotherWindow, 'другая копия', { mode: 0o755 });
  await offer({ ...box.options, windowPath: anotherWindow });
  assert.equal(box.questions.length, 1);
  await box.unchanged();
});

test('PB-MENU-02: no сохраняется, ярлык не создаётся и повтор не спрашивает', async (t) => {
  const box = await fixture(t, false);
  const offer = await integrationApi();

  await offer(box.options);
  await offer(box.options);
  assert.equal(box.questions.length, 1);
  await assert.rejects(fs.stat(box.entry), { code: 'ENOENT' });
  await box.unchanged();
});

test('PB-MENU-03: XDG/fallback и escaping физического AppImage без shell и sudo', async (t) => {
  for (const absoluteXdg of [true, false]) {
    await t.test(absoluteXdg ? 'абсолютный XDG' : 'относительный XDG игнорируется', async (t) => {
      const box = await fixture(t);
      const offer = await integrationApi();
      const windowPath = path.join(box.root, 'copy with spaces/GrigDesk "100%"');

      box.options.windowPath = windowPath;
      await fs.mkdir(path.dirname(windowPath), { recursive: true });
      await fs.writeFile(windowPath, 'физический AppImage', { mode: 0o755 });

      if (!absoluteXdg) {
        box.options.env.XDG_DATA_HOME = 'relative';
      }

      await offer(box.options);

      const entry = absoluteXdg ? box.entry
        : path.join(box.home, '.local/share/applications/grigdesk-portable.desktop');
      const text = await fs.readFile(entry, 'utf8');
      const exec = text.split('\n').find((line) => line.startsWith('Exec='));

      assert.ok(exec);
      assert.ok(exec.startsWith('Exec="'));
      assert.ok(exec.endsWith('"'));
      assert.match(exec, /100%%/u);
      assert.match(exec, /\\+"100/u);
      assert.doesNotMatch(exec, /\/bin\/sh|bash -c|\.mount_|APPDIR|extract-and-run/u);
      assert.ok(exec.includes(box.root));
      assert.equal((await fs.stat(entry)).mode & 0o022, 0);
      await box.unchanged();
    });
  }
});

test('PB-MENU-04: чужой entry и ошибка записи видимы, файлы остаются прежними', async (t) => {
  for (const failure of ['foreign', 'write']) {
    await t.test(failure, async (t) => {
      const box = await fixture(t);
      const offer = await integrationApi();

      if (failure === 'foreign') {
        await fs.mkdir(path.dirname(box.entry), { recursive: true });
        await fs.writeFile(box.entry, 'чужой desktop entry');
      } else {
        // Обычный файл вместо каталога даёт ENOTDIR без зависимости от uid и umask.
        await fs.writeFile(path.join(box.xdg, 'applications'), 'препятствие записи');
      }

      await offer(box.options);
      assert.equal(box.questions.length, 1);
      assert.ok(box.errors.length > 0, 'ошибка добавления показывается человеку');

      if (failure === 'foreign') {
        assert.equal(await fs.readFile(box.entry, 'utf8'), 'чужой desktop entry');
      } else {
        await assert.rejects(fs.stat(box.entry), (error) => ['ENOENT', 'ENOTDIR'].includes(error.code));
      }

      await box.unchanged();
    });
  }
});

test('PB-SKEP-02: перенос не повторяет вопрос и не трогает чужой ярлык', async (t) => {
  const box = await fixture(t);
  const offer = await integrationApi();

  await offer(box.options);
  assert.equal(box.questions.length, 1);
  await fs.writeFile(box.entry, 'подставленный чужой ярлык');

  const movedWindow = path.join(box.root, 'copy B/GrigDesk');

  await fs.mkdir(path.dirname(movedWindow), { recursive: true });
  await fs.rename(box.options.windowPath, movedWindow);
  await offer({ ...box.options, windowPath: movedWindow });
  assert.equal(box.questions.length, 1);
  assert.equal(await fs.readFile(box.entry, 'utf8'), 'подставленный чужой ярлык');
  await box.unchanged();
});
