import assert from 'node:assert/strict';
import test from 'node:test';

import { stoppedTurnBrief } from '../../server/src/lib/chat/stopped-brief.js';

test('досье нет, когда история пуста или остановки не было', () => {
  assert.equal(stoppedTurnBrief(null), '');
  assert.equal(stoppedTurnBrief([]), '');
  assert.equal(stoppedTurnBrief([{ role: 'user', text: 'привет' }]), '');
  assert.equal(stoppedTurnBrief([
    { role: 'assistant', text: 'обычный ответ', steps: [{ k: 'tool', name: 'Edit', title: 'a.js' }] },
  ]), '');
  // stopped был, но не у ПОСЛЕДНЕГО assistant-сообщения: разговор ушёл дальше.
  assert.equal(stoppedTurnBrief([
    { role: 'assistant', text: '⏹ Ход остановлен.', stopped: true, steps: [{ k: 'tool', name: 'Edit', title: 'a.js' }] },
    { role: 'assistant', text: 'продолжил и закончил' },
  ]), '');
});

test('досье собирается из шагов остановленного хода', () => {
  const brief = stoppedTurnBrief([
    { role: 'user', text: 'сделай' },
    {
      role: 'assistant', text: '⏹ Ход остановлен.', stopped: true,
      steps: [
        { k: 'start', model: 'kimi-test' },
        { k: 'note', text: 'Kimi анализирует задачу…' },
        { k: 'tool', name: 'Edit', title: 'chat.js' },
        { k: 'res', ok: true, text: 'готово' },
        { k: 'tool', name: 'Bash', title: 'npm test' },
        { k: 'res', ok: false, text: '1 failing\nstack trace' },
      ],
    },
    { role: 'user', text: 'продолжай' },
  ]);
  assert.ok(brief.includes('[Досье прерванного хода]'));
  assert.ok(brief.includes('- Edit: chat.js'));
  assert.ok(brief.includes('- Bash: npm test'));
  // Провал шага — только первая строка его текста.
  assert.ok(brief.includes('- Ошибка: 1 failing'));
  assert.ok(!brief.includes('stack trace'));
  // Размышления, успешные итоги и служебный start в досье не входят.
  assert.ok(!brief.includes('анализирует'));
  assert.ok(!brief.includes('готово'));
  assert.ok(!brief.includes('kimi-test'));
});

test('legacy: остановленный ход без флага распознаётся по тексту-заглушке', () => {
  const brief = stoppedTurnBrief([
    { role: 'assistant', text: '⏹ Ход остановлен.', steps: [{ k: 'tool', name: 'Edit', title: 'a.js' }] },
  ]);
  assert.ok(brief.includes('- Edit: a.js'));
});

test('без шагов и без частичного ответа досье пустое', () => {
  assert.equal(stoppedTurnBrief([
    { role: 'assistant', text: '⏹ Ход остановлен.', stopped: true, steps: [] },
  ]), '');
});

test('длинный ход: в досье только хвост в 20 шагов с пометкой об остальных', () => {
  const steps = Array.from({ length: 25 }, (_, i) => ({ k: 'tool', name: 'Edit', title: `f${i}.js` }));
  const brief = stoppedTurnBrief([
    { role: 'assistant', text: '⏹ Ход остановлен.', stopped: true, steps },
  ]);
  assert.ok(brief.includes('- Edit: f24.js'));
  assert.ok(!brief.includes('- Edit: f4.js'));
  assert.ok(brief.includes('(и ранее — ещё 5 шагов)'));
});

test('нестандартный текст остановленного хода попадает как частичный ответ', () => {
  const brief = stoppedTurnBrief([
    { role: 'assistant', text: 'Успел начать: нашёл причину бага в', stopped: true, steps: [] },
  ]);
  assert.ok(brief.includes('Частичный ответ агента перед остановкой:'));
  assert.ok(brief.includes('нашёл причину бага'));
});

test('явный сброс памяти после стопа отменяет досье', () => {
  assert.equal(stoppedTurnBrief([
    { role: 'assistant', text: '⏹ Ход остановлен.', stopped: true, steps: [{ k: 'tool', name: 'Edit', title: 'a.js' }] },
    { role: 'note', text: '🧹 Память агента сброшена — следующее сообщение начнёт разговор с нуля.' },
    { role: 'user', text: 'начнём заново' },
  ]), '');
  // А note ДО остановленного хода на досье не влияет: побеждает более позднее намерение.
  const brief = stoppedTurnBrief([
    { role: 'note', text: '🧹 Память агента сброшена — следующее сообщение начнёт разговор с нуля.' },
    { role: 'assistant', text: '⏹ Ход остановлен.', stopped: true, steps: [{ k: 'tool', name: 'Edit', title: 'a.js' }] },
  ]);
  assert.ok(brief.includes('- Edit: a.js'));
});
