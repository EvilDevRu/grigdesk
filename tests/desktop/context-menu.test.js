import assert from 'node:assert/strict';
import test from 'node:test';
import { showStyledContextMenu } from '../../desktop/src/contextMenu.ts';

/**
 * Ответ renderer не может добавить команду: проверяется исходный шаблон главного процесса.
 * Заглушка окна фиксирует только реально исполненные действия.
 */
function fixture(result) {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: async () => result,
      copy: () => calls.push('copy'),
    },
  };
  const template = [
    { role: 'copy', label: 'Копировать' },
    { type: 'separator' },
    { label: 'Ссылка', click: () => calls.push('link') },
  ];

  return {
    window,
    template,
    calls,
  };
}

test('выбор исполняет только разрешённые команды исходного меню', async () => {
  for (const [result, expected] of [[0, ['copy']], [2, ['link']], [1, []], [99, []], [null, []]]) {
    const { window, template, calls } = fixture(result);

    assert.equal(await showStyledContextMenu(window, { x: 2, y: 3 }, template), true);
    assert.deepEqual(calls, expected);
  }
});

test('документ без host использует системное меню', async () => {
  const { window, template, calls } = fixture('native');

  assert.equal(await showStyledContextMenu(window, { x: 2, y: 3 }, template), false);
  assert.deepEqual(calls, []);
});
