import assert from 'node:assert/strict';
import test from 'node:test';

import { sshCommandParts } from '../../web/src/shared/sshCommandParts.ts';

test('SSH-команда разбивается по верхним разделителям без изменения исходных символов', () => {
  const command = 'cd /srv/app && npm ci; npm test || exit 1\nprintf done\n';
  const parts = sshCommandParts(command);

  assert.deepEqual(parts, ['cd /srv/app &&', ' npm ci;', ' npm test ||', ' exit 1\n', 'printf done\n']);
  assert.equal(parts.join(''), command);
});

test('кавычки, escape, группы и комментарии не превращаются в отдельные команды', () => {
  const command = String.raw`printf 'a;b && c' "d; e" a\;b && (echo one; echo two); echo end`;
  const commented = 'echo one # ; && не команда\necho two';

  assert.deepEqual(sshCommandParts(command), [
    String.raw`printf 'a;b && c' "d; e" a\;b &&`,
    ' (echo one; echo two);',
    ' echo end',
  ]);
  assert.deepEqual(sshCommandParts(commented), ['echo one # ; && не команда\n', 'echo two']);
});

test('heredoc, подстановки и незакрытые конструкции остаются в исходном виде', () => {
  const commands = [
    'cat <<EOF\nfirst; && second\nEOF\necho done',
    'echo "$(printf "; &&")" && echo done',
    'echo `date` && echo done',
    'echo one; printf "unfinished;',
    'echo one; (echo two',
    'echo one; echo two)',
  ];

  for (const command of commands) {
    assert.deepEqual(sshCommandParts(command), [command]);
  }

  assert.deepEqual(sshCommandParts(''), []);
});

test('пустые строки и хвостовые пробелы сохраняются, продолжение строки не разбивается', () => {
  const command = 'echo one &&\n\n  echo two;  \n';
  const continued = 'echo one \\\n two && echo three';

  assert.equal(sshCommandParts(command).join(''), command);
  assert.deepEqual(sshCommandParts(continued), ['echo one \\\n two &&', ' echo three']);
});
