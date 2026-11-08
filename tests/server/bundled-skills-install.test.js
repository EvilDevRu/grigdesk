import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { installBundledSkills } from '../../server/src/lib/skills/bundledSkills.ts';

/**
 * Создаёт изолированные корень комплекта и home пользователя внутри папки артефактов.
 * Настоящие ~/.agents и исходники репозитория проверка не читает и не меняет.
 */
async function fixture(t) {
  const artifacts = artifactsPath({ env: process.env, home: os.homedir() });
  const directory = path.join(artifacts, 'bundled-skills');

  await fs.mkdir(directory, { recursive: true });

  const base = await fs.mkdtemp(path.join(directory, 'fixture-'));
  const root = path.join(base, 'root');
  const home = path.join(base, 'home');
  const source = path.join(root, 'tools', 'skills');

  await fs.mkdir(source, { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  return {
    base,
    root,
    home,
    source,
    // Хелпер пишет bundle с обязательным SKILL.md: каталог без этого файла встроенным
    // навыком не считается и проверяется отдельным сценарием без хелпера.
    async writeSkill(name, text) {
      const bundle = path.join(source, name);

      await fs.mkdir(bundle, { recursive: true });
      await fs.writeFile(path.join(bundle, 'SKILL.md'), text);

      return bundle;
    },
  };
}

test('Встроенные навыки устанавливаются при старте и чужие записи не трогают', async (t) => {
  const f = await fixture(t);
  const bundle = await f.writeSkill('connect-project', '---\nname: connect-project\n---\nТело навыка\n');

  await fs.writeFile(path.join(bundle, 'extra.md'), 'Дополнительный файл\n');

  const own = path.join(f.home, '.agents', 'skills', 'my-own');

  await fs.mkdir(own, { recursive: true });
  await fs.writeFile(path.join(own, 'SKILL.md'), '---\nname: my-own\n---\nПользовательский навык\n');

  assert.deepEqual(await installBundledSkills({ home: f.home, root: f.root }), ['connect-project']);

  const installed = await fs.readFile(
    path.join(f.home, '.agents', 'skills', 'connect-project', 'SKILL.md'), 'utf8');

  const ownSkill = await fs.readFile(path.join(own, 'SKILL.md'), 'utf8');

  assert.equal(installed, '---\nname: connect-project\n---\nТело навыка\n');
  assert.equal(ownSkill, '---\nname: my-own\n---\nПользовательский навык\n');
});

test('Повторный синк зеркалирует источник и убирает устаревшие файлы копии', async (t) => {
  const f = await fixture(t);
  const bundle = await f.writeSkill('connect-project', '---\nname: connect-project\n---\nПервая редакция\n');

  await fs.writeFile(path.join(bundle, 'stale.md'), 'Устареет\n');
  await fs.mkdir(path.join(f.home, '.agents', 'skills'), { recursive: true });
  await fs.cp(bundle, path.join(f.home, '.agents', 'skills', 'connect-project'), { recursive: true });

  await fs.writeFile(path.join(bundle, 'SKILL.md'), '---\nname: connect-project\n---\nВторая редакция\n');
  await fs.rm(path.join(bundle, 'stale.md'));

  assert.deepEqual(await installBundledSkills({ home: f.home, root: f.root }), ['connect-project']);

  const target = path.join(f.home, '.agents', 'skills', 'connect-project');

  assert.match(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), /Вторая редакция/);
  await assert.rejects(fs.access(path.join(target, 'stale.md')));
});

test('Некорректные имена, flat-файлы и навыки без SKILL.md пропускаются', async (t) => {
  const f = await fixture(t);

  await f.writeSkill('connect-project', '---\nname: connect-project\n---\nТело\n');
  await f.writeSkill('Bad_Name', '---\nname: Bad_Name\n---\nПропущен\n');

  const withoutSkill = path.join(f.source, 'no-skill-file');

  await fs.mkdir(withoutSkill, { recursive: true });
  await fs.writeFile(path.join(withoutSkill, 'README.md'), 'Чтение без SKILL.md — не навык меню\n');

  await fs.writeFile(path.join(f.source, 'flat.md'), '---\nname: flat\n---\nFlat не встроенный навык\n');
  await fs.symlink(path.join(f.source, 'connect-project'), path.join(f.source, 'linked'));

  assert.deepEqual(await installBundledSkills({ home: f.home, root: f.root }), ['connect-project']);
});

test('Нет каталога-источника — синк пуст и каталог пользователя не создаётся', async (t) => {
  const f = await fixture(t);
  const emptyRoot = path.join(f.base, 'empty');

  await fs.mkdir(emptyRoot, { recursive: true });

  assert.deepEqual(await installBundledSkills({ home: f.home, root: emptyRoot }), []);
  await assert.rejects(fs.access(path.join(f.home, '.agents')));
});
