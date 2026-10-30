import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readHarnessSkillCommands } from '../../server/src/lib/deepseek/skillCommands.ts';
import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';

/**
 * Изолирует каталог пользователя от навыков машины и приватных homes разговоров.
 * Все файлы проверки живут в артефактах и удаляются после сценария.
 */
async function fixture(t) {
  const artifacts = artifactsPath({ env: process.env, home: os.homedir() });
  const directory = path.join(artifacts, 'harness-skill-menu');

  await fs.mkdir(directory, { recursive: true });

  const home = await fs.mkdtemp(path.join(directory, 'fixture-'));
  const skills = path.join(home, '.agents', 'skills');

  await fs.mkdir(skills, { recursive: true });
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  return {
    home,
    skills,
    async write(name, header) {
      const bundle = path.join(skills, name);

      await fs.mkdir(bundle, { recursive: true });
      await fs.writeFile(path.join(bundle, 'SKILL.md'), `---\n${header}\n---\nИнструкции навыка.\n`);
    },
  };
}

test('Harness публикует общие навыки: YAML, ссылки, flat-файлы, имена и порядок', async (t) => {
  const f = await fixture(t);

  await f.write('directory-name', 'name: zeta\ndescription: >-\n  Первая строка\n  вторая строка');
  await f.write('duplicate', 'name: zeta\ndescription: Дубль');
  await fs.writeFile(path.join(f.skills, 'alpha.md'),
    '---\r\nname: alpha\r\ndescription: "Проверка: YAML"\r\n---\r\nТело');
  await fs.symlink(path.join(f.skills, 'directory-name'), path.join(f.skills, 'symlink'));
  await fs.symlink(path.join(f.skills, 'missing'), path.join(f.skills, 'broken-link'));
  await f.write('long', `name: long\ndescription: ${'Д'.repeat(200)}`);
  await f.write('nested/ignored', 'name: ignored\ndescription: Вложенный навык');
  await f.write('bad-yaml', 'name: [broken\ndescription: Ошибка');
  await f.write('bad-name', 'name: Bad_Name\ndescription: Ошибка');
  await f.write('no-description', 'name: no-description');

  const commands = await readHarnessSkillCommands({ home: f.home });

  assert.deepEqual(commands.map((command) => command.cmd), ['/alpha', '/long', '/zeta']);
  assert.equal(commands[0].desc, 'Проверка: YAML');
  assert.equal(commands[1].desc.length, 120);
  assert.equal(commands[2].desc, 'Первая строка вторая строка');
  assert.ok(commands.every((command) => command.kind === 'skill' && command.run === 'prompt'));
});

test('Harness соблюдает user-invocable и строгую грамматику invocation-полей', async (t) => {
  const f = await fixture(t);
  const policies = [
    ['explicit-only', 'disable-model-invocation: true'],
    ['human', 'user-invocable: "YES"'],
    ['hidden', 'user-invocable: false'],
    ['hidden-zero', 'user-invocable: "0"'],
    ['invalid', 'user-invocable: maybe'],
    ['invalid-model', 'disable-model-invocation: maybe'],
    ['array', 'user-invocable: [true]'],
    ['legacy', 'userInvocable: false'],
  ];

  for (const [name, policy] of policies) {
    await f.write(name, `name: ${name}\ndescription: Проверка\n${policy}`);
  }

  const commands = await readHarnessSkillCommands({ home: f.home });

  assert.deepEqual(commands.map((command) => command.cmd), ['/explicit-only', '/human']);
  assert.deepEqual(await readHarnessSkillCommands({ home: path.join(f.home, 'missing') }), []);
});

test('GLM и DeepSeek читают общий home, обновляют каталог и не берут проектные навыки', async (t) => {
  const f = await fixture(t);
  const previousHome = process.env.HOME;

  process.env.HOME = f.home;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  const glm = createGlmAdapter({ env: {} });
  const config = { rootDir: path.join(f.home, 'project') };
  const projectSkills = path.join(config.rootDir, '.agents', 'skills');

  await fs.mkdir(projectSkills, { recursive: true });
  await fs.writeFile(path.join(projectSkills, 'project.md'),
    '---\nname: project\ndescription: Только в проекте\n---');
  await f.write('shared', 'name: shared\ndescription: Общий навык');

  const expected = [{
    cmd: '/shared',
    desc: 'Общий навык',
    run: 'prompt',
    kind: 'skill',
  }];

  assert.deepEqual(await deepseek.commands(config), expected);
  assert.deepEqual(await glm.commands(config), expected);

  await fs.rm(path.join(f.skills, 'shared'), { recursive: true });

  assert.deepEqual(await deepseek.commands(config), []);
  assert.deepEqual(await glm.commands(config), []);
});
