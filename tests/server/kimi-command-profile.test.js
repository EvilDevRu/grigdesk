import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { buildCommandProfile, COMMAND_NAME } from '../../server/src/lib/kimi/commandProfile.ts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { parse } = requireServer('smol-toml');

test('профиль сохраняет данные и заменяет доступный Bash контролируемым tool', () => {
  const source = 'secret = "fixture"\n[tools]\nenabled = ["Read", "Bash"]\ndisabled = ["Edit"]\n';
  const result = buildCommandProfile(source);
  const data = parse(result.content);

  assert.equal(result.commandsAllowed, true);
  assert.equal(data.secret, 'fixture');
  assert.deepEqual(data.tools.disabled, ['Edit', 'Bash']);
  assert.deepEqual(data.tools.enabled, ['Read', 'Bash', COMMAND_NAME]);
  assert.deepEqual(buildCommandProfile(result.content).content, result.content);
});

test('пользовательские ограничения не теряются за заменой инструмента', () => {
  const inputs = [
    '[tools]\ndisabled = ["Bash"]\n',
    '[tools]\nenabled = ["Read"]\n',
    '[[permission.rules]]\ndecision = "deny"\npattern = "Bash(rm *)"\n',
    '[[hooks]]\nevent = "PreToolUse"\nmatcher = "^Bash$"\ncommand = "false"\n',
    '[[hooks]]\nevent = "PreToolUse"\nmatcher = "["\ncommand = "true"\n',
  ];

  for (const source of inputs) {
    assert.equal(buildCommandProfile(source).commandsAllowed, false);
  }

  assert.equal(buildCommandProfile('[[hooks]]\nevent = "Stop"\ncommand = "true"\n').commandsAllowed, true);
});

test('битая конфигурация не заменяется пустым разрешающим документом', () => {
  assert.throws(() => buildCommandProfile('[broken'));
  assert.throws(() => buildCommandProfile('[tools]\ndisabled = "Bash"\n'));
});
