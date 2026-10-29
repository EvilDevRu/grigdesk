import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';

import { TerminalSession } from '../../cli/terminal.ts';

/**
 * Проверяет байты реального рендера без запуска команд или чтения терминала владельца.
 * Окружение цвета восстанавливается после каждой проверки вместе с её фикстурой.
 */
function terminalOutput(t: TestContext, mode: string, columns = 40) {
  const original = { TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR };
  const writes: string[] = [];
  let value = '';

  process.env.TERM = mode === 'dumb' ? 'dumb' : 'xterm-256color';
  delete process.env.NO_COLOR;

  if (mode === 'NO_COLOR') {
    process.env.NO_COLOR = '1';
  }

  t.after(() => {
    for (const [key, previous] of Object.entries(original)) {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  const output = {
    columns,
    write(chunk: string) {
      writes.push(chunk);
      value += chunk;

      return true;
    },
  } as WriteStream;

  return {
    session: new TerminalSession({ output }),
    output: () => value,
    writes: () => writes,
  };
}

test('терминальные стили очищают внешние escape до окраски и сбрасываются после вывода', (t) => {
  const box = terminalOutput(t, 'color');

  box.session.draw([
    {
      selected: true,
      spans: [
        { text: '› Открыть окно', tone: 'accent' },
        { text: '\x1b[2J\x1b]52;c;malicious\x07\x1b[31m данные\r\n', tone: 'muted' },
      ],
    },
  ], undefined, { theme: 'dark', width: 32 });

  const output = box.output();
  const text = stripVTControlCharacters(output);

  assert.match(output, /\x1b\[[\d;]*m/u);
  assert.equal(output.match(/\x1b\[2J/gu), null);
  assert.doesNotMatch(output, /malicious|\x1b\]52/u);
  assert.equal(text, '› Открыть окно данные'.padEnd(32) + '\n');
  assert.ok(output.endsWith('\x1b[0m\n'));
  assert.equal(box.writes().length, 1, 'Очистка и содержимое должны записываться одним кадром');
});

for (const mode of ['color', 'NO_COLOR']) {
  test(`прогресс меняет только нужные строки и пропускает одинаковые кадры: ${mode}`, (t) => {
    const box = terminalOutput(t, mode);
    const options = {
      theme: 'dark',
      width: 32,
      incremental: true,
    } as const;

    box.session.draw(['Заголовок', '10%', 'Стадия сборки'], undefined, options);
    box.session.draw(['Заголовок', '10%', 'Стадия сборки'], undefined, options);
    assert.equal(box.writes().length, 1);

    box.session.draw(['Заголовок', '11%', 'Стадия сборки'], undefined, options);

    const update = box.writes()[1]!;

    assert.match(update, /\x1b\[2;1H/u);
    assert.match(update, /11%/u);
    assert.doesNotMatch(update, /Заголовок|Стадия|\x1b\[J/u);
    assert.equal(box.writes().length, 2);

    box.session.draw(['Заголовок', '11%'], undefined, options);
    assert.match(box.writes()[2]!, /\x1b\[3;1H(?:\x1b\[[\d;]*m)*\x1b\[J/u,
      'Остаток прежнего кадра удаляется');

    box.session.output.columns = 36;
    box.session.draw(['Заголовок', '11%'], undefined, options);
    assert.match(box.writes()[3]!, /\x1b\[H\x1b\[J/u, 'После resize нужен полный кадр');
    box.session.suspend();

    const before = box.writes().length;

    box.session.draw(['Заголовок', '11%'], undefined, options);
    assert.match(box.writes()[before]!, /\x1b\[H\x1b\[J/u, 'Внешний вывод сбрасывает снимок');
  });
}

for (const mode of ['NO_COLOR', 'dumb']) {
  test(`терминальные стили сохраняют выбор и границы без цвета: ${mode}`, (t) => {
    const box = terminalOutput(t, mode, 18);

    box.session.draw([
      { selected: true, spans: [{ text: '› Открыть окно и продолжить', tone: 'accent' }] },
      { spans: [{ text: 'Описание', tone: 'muted' }] },
    ], undefined, { theme: 'dark', width: 80 });

    const output = box.output();

    assert.doesNotMatch(output, /\x1b\[[\d;]*m/u);
    assert.match(output, /› Открыть окно/u);
    assert.ok(stripVTControlCharacters(output).split('\n').every((line) => [...line].length <= 18));

    if (mode === 'dumb') {
      assert.doesNotMatch(output, /\x1b/u);
    }
  });
}
