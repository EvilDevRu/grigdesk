import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readNodeVerdicts } from '../../server/src/lib/factory-node-verdicts.js';

// Вердикт узла — класс владельца провала и типизированные находки — до 28.08.2026 не
// покидал журнал попытки: в провайдерскую проекцию попадал только однострочный дайджест
// `<КЛЮЧ>_COMMENT`. Человек видел обрезанную строку и шёл читать `stage-results/` руками.

const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
const HASH = 'a'.repeat(64);

async function ledger(events) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verdicts-'));
  const dir = path.join(root, 'protocol-v2', 'tasks', 't1', 'attempts', ATTEMPT, 'stage-results');
  await fs.mkdir(dir, { recursive: true });
  for (const [i, event] of events.entries()) {
    const seq = String(i).padStart(20, '0');
    await fs.writeFile(path.join(dir, `event.${seq}.${HASH}.json`), JSON.stringify(event));
  }
  return root;
}

const read = (controlDir) => readNodeVerdicts({ controlDir, task: '1', attempt: ATTEMPT });

test('отдаёт находки узла с якорями и классом владельца', async () => {
  const controlDir = await ledger([
    {
      kind: 'commit',
      node: 'hyposkeptic',
      outcome: 'failed',
      action: { stop: 'human' },
      at: '2026-08-27T11:25:23Z',
      verdict: {
        owner: 'human',
        reviewed: ['src/a.ts'],
        findings: [
          { id: 'lever-empty', anchor: 'src/a.ts', summary: 'рычаг измерен и пуст' },
          { id: 'needs-frame', summary: 'нужна рамка от человека' },
        ],
      },
    },
  ]);

  const verdicts = await read(controlDir);

  assert.equal(verdicts.hyposkeptic.owner, 'human');
  assert.equal(verdicts.hyposkeptic.stop, 'human');
  assert.equal(verdicts.hyposkeptic.outcome, 'failed');
  assert.equal(verdicts.hyposkeptic.findings.length, 2);
  assert.equal(verdicts.hyposkeptic.findings[0].anchor, 'src/a.ts');
  assert.equal(verdicts.hyposkeptic.findings[0].summary, 'рычаг измерен и пуст');
  assert.equal(verdicts.hyposkeptic.reviewed.length, 1);
});

// Узел законно заходит несколько раз (возврат, повтор после ремонта). Показывать надо,
// чем он КОНЧИЛ: ранняя находка могла быть уже снята следующим заходом.
test('поздний вердикт узла перекрывает ранний', async () => {
  const controlDir = await ledger([
    {
      kind: 'commit',
      node: 'review',
      outcome: 'failed',
      action: { rewind: 'build' },
      verdict: { owner: 'plan', findings: [{ id: 'old', summary: 'первое замечание' }] },
    },
    {
      kind: 'commit',
      node: 'review',
      outcome: 'done',
      action: { next: 'gate_accept' },
      verdict: { owner: null, findings: [{ id: 'new', summary: 'осталось одно, отложено', severity: 'deferred' }] },
    },
  ]);

  const verdicts = await read(controlDir);

  assert.equal(verdicts.review.findings.length, 1);
  assert.equal(verdicts.review.findings[0].id, 'new');
  assert.equal(verdicts.review.findings[0].severity, 'deferred');
  assert.equal(verdicts.review.outcome, 'done');
});

// Вес по умолчанию — `blocking`: события, записанные до появления поля, читаются так же,
// как их читает сам движок. Приглушить блокирующую находку хуже, чем выделить снятую.
test('находка без веса считается блокирующей', async () => {
  const controlDir = await ledger([
    { kind: 'commit', node: 'lint', verdict: { findings: [{ summary: 'а' }, { summary: 'б', severity: 'мусор' }] } },
  ]);

  const verdicts = await read(controlDir);

  assert.equal(verdicts.lint.findings[0].severity, 'blocking');
  assert.equal(verdicts.lint.findings[1].severity, 'blocking');
});

// Текст пишет агент — это недоверенные данные, которые уезжают в браузер и в подсказки.
test('управляющие символы и длина находки ограничены', async () => {
  const summary = `строка\u0000с\u001bуправляющими\nи переносом${'я'.repeat(2000)}`;
  const controlDir = await ledger([
    { kind: 'commit', node: 'build', verdict: { findings: [{ summary, anchor: 'x'.repeat(500) }] } },
  ]);

  const verdicts = await read(controlDir);
  const finding = verdicts.build.findings[0];

  assert.equal(/[\u0000-\u001f\u007f]/.test(finding.summary), false);
  assert.equal(finding.summary.length <= 901, true);
  assert.equal(finding.anchor.length <= 201, true);
});

test('число находок ограничено, лишние сосчитаны', async () => {
  const findings = Array.from({ length: 26 }, (_, i) => ({ id: `f${i}`, summary: `находка ${i}` }));
  const controlDir = await ledger([{ kind: 'commit', node: 'audit', verdict: { findings } }]);

  const verdicts = await read(controlDir);

  assert.equal(verdicts.audit.findings.length, 20);
  assert.equal(verdicts.audit.omitted, 6);
});

// Пустая карточка на узле обещает содержание, которого нет: узел без вердикта должен
// выглядеть ровно как раньше.
test('событие без вердикта не создаёт запись узла', async () => {
  const controlDir = await ledger([
    { kind: 'commit', node: 'tests', outcome: 'done', action: { next: 'review' } },
    { kind: 'commit', node: 'empty', verdict: { findings: [], reviewed: [] } },
  ]);

  const verdicts = await read(controlDir);

  assert.equal(Object.keys(verdicts).length, 0);
});

// Вердикт — дополнение к карточке узла. Нечитаемый журнал не имеет права уронить граф:
// без него человек остался бы вообще без страницы конвейера.
test('недоступный журнал даёт пустую карту, а не ошибку', async () => {
  const verdicts = await readNodeVerdicts({
    controlDir: path.join(os.tmpdir(), 'нет-такого-каталога-verdicts'),
    task: '1',
    attempt: ATTEMPT,
  });

  assert.deepEqual(verdicts, {});
});

test('битый файл события пропускается, соседние читаются', async () => {
  const controlDir = await ledger([
    { kind: 'commit', node: 'plan', verdict: { findings: [{ summary: 'цел' }] } },
  ]);
  const dir = path.join(controlDir, 'protocol-v2', 'tasks', 't1', 'attempts', ATTEMPT, 'stage-results');
  await fs.writeFile(path.join(dir, `event.${'1'.padStart(20, '0')}.${HASH}.json`), '{битый');

  const verdicts = await read(controlDir);

  assert.equal(verdicts.plan.findings[0].summary, 'цел');
});

test('имя узла из журнала проверяется, чужой ключ отбрасывается', async () => {
  const controlDir = await ledger([
    { kind: 'commit', node: '../../evil', verdict: { findings: [{ summary: 'подделка' }] } },
    { kind: 'commit', node: 'proof', verdict: { findings: [{ summary: 'настоящая' }] } },
  ]);

  const verdicts = await read(controlDir);

  assert.deepEqual(Object.keys(verdicts), ['proof']);
});
