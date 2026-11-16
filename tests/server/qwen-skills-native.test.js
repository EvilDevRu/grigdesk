import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import { qwenAdapter, runInput } from '../helpers/qwenFixture.mjs';

/**
 * Навык и его ресурсы находятся вне workspace; соседний секрет не относится к bundle.
 * Проверка использует настоящий CLI и локальный API, без ключей владельца и платных запросов.
 */
async function skillFixture(t) {
  const fixture = await qwenNativeFixture(t);
  const skills = path.join(fixture.home, '.agents', 'skills');
  const bundle = path.join(fixture.home, 'shared-bundle');
  const resource = path.join(bundle, 'reference.txt');
  const secret = path.join(fixture.home, 'private.txt');
  const manifest = path.join(bundle, 'SKILL.md');

  await mkdir(skills, { recursive: true });
  await mkdir(bundle);
  await writeFile(manifest, '---\nname: shared-probe\ndescription: SHARED_SKILL_DESCRIPTION\n---\n'
    + 'SHARED_SKILL_BODY. Прочитай reference.txt из каталога этого навыка.\n');
  await writeFile(resource, 'SHARED_SKILL_RESOURCE');
  await writeFile(secret, 'PRIVATE_SKILL_NEIGHBOR');
  await symlink(bundle, path.join(skills, 'shared-probe'));
  await symlink(secret, path.join(bundle, 'escape.txt'));

  return {
    ...fixture,
    skills,
    bundle,
    resource,
    secret,
    manifest,
  };
}

test('Qwen sandbox: видит общий навык, загружает инструкции и ресурсы, сохраняет read-only', {
  timeout: 90000,
}, async (t) => {
  const fixture = await skillFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const marker = path.join(fixture.workspace, 'skills-check.txt');
  const actions = [
    { name: 'skill', args: { skill: 'shared-probe' } },
    { name: 'read_file', args: { file_path: path.join(fixture.skills, 'shared-probe/reference.txt') } },
    { name: 'write_file', args: { file_path: fixture.resource, content: 'ILLEGAL_CHANGE' } },
    { name: 'read_file', args: { file_path: path.join(fixture.bundle, 'escape.txt') } },
    { name: 'run_shell_command', args: {
      command: `test ! -e '${fixture.secret}' && cat '${fixture.resource}' > '${marker}'`
        + ` && if printf BAD > '${fixture.resource}'; then exit 1; fi`,
    } },
  ];

  fixture.actions.push(...actions);

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    permissionMode: 'yolo',
    signal: AbortSignal.timeout(60000),
  }));
  const wire = JSON.stringify(fixture.requests);

  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.ok(actions.every((action) => action.missing === undefined), 'CLI объявил проверяемые инструменты');
  assert.match(JSON.stringify(fixture.requests[0]), /SHARED_SKILL_DESCRIPTION/, 'Модель видит каталог');
  assert.match(wire, /SHARED_SKILL_BODY/, 'Skill tool загрузил текст инструкции');
  assert.ok(wire.includes('SHARED_SKILL_RESOURCE'), 'ReadFile прочитал ресурс bundle');
  assert.doesNotMatch(wire, /PRIVATE_SKILL_NEIGHBOR/, 'Ссылка не открыла соседний секрет');
  assert.equal(await readFile(fixture.resource, 'utf8'), 'SHARED_SKILL_RESOURCE');
  assert.equal(await readFile(marker, 'utf8'), 'SHARED_SKILL_RESOURCE');
});

test('Qwen sandbox: навык остаётся read-only при совпадении с выбранной рабочей папкой', {
  timeout: 60000,
}, async (t) => {
  const fixture = await skillFixture(t);
  const adapter = await qwenAdapter({ runnable: true });

  fixture.actions.push({ name: 'run_shell_command', args: {
    command: `if printf BAD > '${fixture.resource}'; then exit 1; else printf READONLY_OVERLAP_OK; fi`,
  } });

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    cwd: fixture.bundle,
    permissionMode: 'yolo',
    signal: AbortSignal.timeout(45000),
  }));

  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.equal(await readFile(fixture.resource, 'utf8'), 'SHARED_SKILL_RESOURCE');

  const results = fixture.requests.flatMap((request) => request.messages || [])
    .filter((message) => message.role === 'tool');

  assert.ok(JSON.stringify(results).includes('READONLY_OVERLAP_OK'));
});

test('Qwen sandbox: явный /навык из меню раскрывается настоящим ACP', {
  timeout: 60000,
}, async (t) => {
  const fixture = await skillFixture(t);
  const adapter = await qwenAdapter({ runnable: true });

  await writeFile(fixture.manifest, '---\nname: shared-probe\ndescription: Явный навык\n'
    + 'disable-model-invocation: true\n---\nEXPLICIT_SKILL_BODY\n');

  const result = await adapter.run(runInput(fixture, 'shared-model(openai)', {
    message: '/shared-probe EXPLICIT_SKILL_ARGUMENT\n\n'
      + '[Контекст GrigDesk]\nSKILL_UI_CONTEXT\n[/Контекст]\n\n'
      + '[Служебный хук GrigDesk: название чата]\nSKILL_TITLE_HINT\n[/Служебный хук]',
    signal: AbortSignal.timeout(45000),
  }));

  assert.match(result.reply, /Ответ настоящего CLI/);
  assert.match(JSON.stringify(fixture.requests), /EXPLICIT_SKILL_BODY/);
  assert.match(JSON.stringify(fixture.requests), /EXPLICIT_SKILL_ARGUMENT/);
  assert.match(JSON.stringify(fixture.requests), /SKILL_UI_CONTEXT/);
  assert.match(JSON.stringify(fixture.requests), /SKILL_TITLE_HINT/);
});
