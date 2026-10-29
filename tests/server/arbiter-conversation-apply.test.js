import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { arbiterDecisionFixture } from './helpers/arbiterDecisionFixture.js';
import { readFactoryStageEvent } from '../../server/src/lib/factoryAttemptLedger.ts';
import { ArbiterConversationStore } from '../../server/src/lib/arbiterConversationStore.ts';
import { ArbiterConversationApply } from '../../server/src/lib/arbiterConversationApply.ts';
import { readArbiterStopContext } from '../../server/src/lib/arbiterStopContext.ts';

/**
 * Durable intent сохраняется до первого вызова настоящего rewind helper.
 * Resume намеренно отказывает, позволяя проверить независимость этих двух исходов.
 */
async function applyFixture(t) {
  const fx = await arbiterDecisionFixture(t);
  const context = await readArbiterStopContext({ readTrustedAttempt: fx.trusted }, fx.config, '7');
  const store = new ArbiterConversationStore(path.join(fx.root, 'conversations'));
  let doc = await store.create(context.identity, {
    status: 'supported',
    message: '',
    targets: context.targets
  });
  const reason = 'Проверь журнал целиком. ' + 'Длинное указание без потерь. '.repeat(450);
  const operation = {
    id: 'apply-1',
    requestId: 'request-1',
    fingerprint: 'a'.repeat(64),
    kind: 'apply',
    outcome: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reason,
    action: {
      kind: 'return_to_node',
      targetNode: 'instrument',
      instruction: reason
    },
    originalStage: { sequence: context.identity.stageSequence, headEventHash: context.identity.stageHeadHash }
  };

  doc = await store.update('7', doc.id, (current) => {
    current.state = 'applying';
    current.operations.push(operation);
  });

  let gotoCalls = 0;
  let resumeCalls = 0;
  const controls = { running: false, resumeOk: false };
  const apply = new ArbiterConversationApply({
    store,
    controlDir: fx.controlDir,
    readTrusted: fx.trusted,
    goto: async (_identity, action, text, expected) => {
      gotoCalls += 1;
      await fx.rewind(action.targetNode, text, expected);

      throw new Error('Ответ потерян после append');
    },
    resume: async () => {
      resumeCalls += 1;
      controls.running = controls.resumeOk;

      return { ok: controls.resumeOk, message: 'Стенд недоступен.' };
    },
    running: async () => controls.running
  });

  return {
    ...fx,
    store,
    doc,
    operation,
    apply,
    controls,
    gotoCalls: () => gotoCalls,
    resumeCalls: () => resumeCalls
  };
}

test('потерянный ответ goto подтверждается exact событием; reason доходит целиком', async (t) => {
  const fx = await applyFixture(t);

  await fx.apply.apply(fx.doc, fx.operation);

  const doc = await fx.store.read('7', fx.doc.id);

  assert.equal(doc.operations[0].outcome, 'resume_failed');
  assert.equal(doc.operations[0].receipt.reason, fx.operation.reason);
  assert.equal(doc.operations[0].receipt.stage.sequence, 3);
  assert.equal(fx.gotoCalls(), 1);
  assert.equal(fx.resumeCalls(), 1);
  assert.match(doc.messages.at(-1).text, /принято.*не запущен/);
});

test('crash recovery сверяет receipt без второго goto; чужое указание не принимается', async (t) => {
  const fx = await applyFixture(t);

  await fx.rewind('instrument', fx.operation.reason, fx.operation.originalStage);
  await fx.apply.recover(fx.doc);

  const recovered = await fx.store.read('7', fx.doc.id);

  assert.equal(recovered.operations[0].outcome, 'accepted');
  assert.equal(fx.gotoCalls(), 0);
  assert.equal(fx.resumeCalls(), 0);

  const other = await applyFixture(t);

  await other.rewind('instrument', 'Чужой reason', other.operation.originalStage);
  await other.apply.recover(other.doc);
  assert.equal((await other.store.read('7', other.doc.id)).operations[0].receipt, undefined);
});

test(("повтор после resume_failed запускает только resume, работающий визит не " +
  "запускается снова"),
  async (t) => {
    const fx = await applyFixture(t);

    await fx.apply.apply(fx.doc, fx.operation);

    let doc = await fx.store.read('7', fx.doc.id);
    const receipt = doc.operations[0].receipt;
    const resume = {
      ...fx.operation,
      id: 'resume-1',
      requestId: 'resume-request',
      kind: 'resume',
      outcome: 'running'
    };

    doc = await fx.store.update('7', doc.id, (current) => current.operations.push(resume));

    const payload = {
      applyOperationId: fx.operation.id,
      acceptedEvent: receipt.stage,
      expectedCurrentStage: receipt.stage
    };

    fx.controls.resumeOk = true;
    await fx.apply.resume(doc, resume, payload);

    assert.equal(fx.gotoCalls(), 1);
    assert.equal(fx.resumeCalls(), 2);
    assert.equal((await fx.store.read('7', doc.id)).operations[0].outcome, 'resumed');
    await fx.apply.resume((await fx.store.read('7', doc.id)), resume, payload);
    assert.equal(fx.resumeCalls(), 2);
  }
);

test('ready не означает running; фактический commit повторённого узла добавляет исход', async (t) => {
  const fx = await applyFixture(t);

  await fx.apply.apply(fx.doc, fx.operation);

  let doc = await fx.store.read('7', fx.doc.id);

  assert.equal(doc.operations[0].observation, 'waiting');
  await fx.call('attempt_stage_state_commit_v2', '7', fx.attempt, 'instrument', 'done');
  await fx.apply.observe(doc);
  doc = await fx.store.read('7', doc.id);

  assert.equal(doc.operations[0].observation, 'completed');
  assert.match(doc.messages.at(-1).text, /Этап завершён, конвейер продолжает работу/);
  assert.match(doc.messages.at(-1).text, /Итог всей задачи ещё не подтверждён/);
});

test('повторённый узел с новым human stop сохраняет доказанный отказ и другую identity', async (t) => {
  const fx = await applyFixture(t);

  await fx.apply.apply(fx.doc, fx.operation);
  await fx.call('attempt_stage_state_commit_v2', '7', fx.attempt, 'instrument', 'skipped');
  await fx.apply.observe(await fx.store.read('7', fx.doc.id));

  const doc = await fx.store.read('7', fx.doc.id);

  assert.equal(doc.operations[0].observation, 'stopped');
  assert.equal(doc.operations[0].nextStop.node, 'instrument');
  assert.equal(doc.operations[0].nextStop.stop, 'human');
  assert.equal(doc.operations[0].nextStop.stageSequence, 4);
  assert.notEqual(doc.operations[0].nextStop.stageHeadHash, doc.identity.stageHeadHash);
});

test('exact immutable событие проверяется до trusted head, повреждённые bytes не принимаются', async (t) => {
  const fx = await arbiterDecisionFixture(t);
  const trusted = await fx.trusted();
  const event = await readFactoryStageEvent(fx.controlDir, trusted, 2);

  assert.equal(event.node, 'check');
  assert.equal(event.verdict.owner, 'tests');
  assert.equal(event.eventHash, trusted.stageIdentity.headEventHash);

  const file = path.join(fx.attemptDir, 'stage-results',
    `event.${'2'.padStart(20, '0')}.${event.eventHash}.json`);

  await fs.chmod(file, 0o600);
  await fs.appendFile(file, ' ');
  await assert.rejects(readFactoryStageEvent(fx.controlDir, trusted, 2), /content|chain/);
});

test('чужой target или actor не подтверждает apply даже при совпадении reason', async (t) => {
  for (const variant of ['target', 'actor']) {
    const fx = await applyFixture(t);

    await fx.rewind(variant === 'target' ? 'check' : 'instrument', fx.operation.reason,
      fx.operation.originalStage, variant === 'actor' ? 'arbiter' : 'human');
    await fx.apply.recover(fx.doc);

    const doc = await fx.store.read('7', fx.doc.id);

    assert.equal(doc.operations[0].outcome, 'failed');
    assert.equal(doc.operations[0].receipt, undefined);
    assert.equal(fx.gotoCalls(), 0);
    assert.equal(fx.resumeCalls(), 0);
  }
});

test(("событие отсутствует или цепочка не связана с исходным head: outcome " +
  "unknown, повторов нет"),
  async (t) => {
    const missing = await applyFixture(t);

    await missing.apply.recover(missing.doc);
    assert.equal((await missing.store.read('7', missing.doc.id)).operations[0].outcome, 'unknown');
    assert.equal(missing.gotoCalls(), 0);

    const mismatch = await applyFixture(t);

    await mismatch.rewind('instrument', mismatch.operation.reason, mismatch.operation.originalStage);
    await mismatch.store.update('7', mismatch.doc.id, (current) => {
      current.operations[0].originalStage.headEventHash = 'f'.repeat(64);
    });
    await mismatch.apply.recover(await mismatch.store.read('7', mismatch.doc.id));

    assert.equal((await mismatch.store.read('7', mismatch.doc.id)).operations[0].receipt, undefined);
    assert.equal(mismatch.resumeCalls(), 0);
  }
);

test('позднейшие события не теряют receipt; чужой rewind запрещает resume-only', async (t) => {
  const fx = await applyFixture(t);

  await fx.rewind('instrument', fx.operation.reason, fx.operation.originalStage);
  await fx.call('attempt_stage_state_commit_v2', '7', fx.attempt, 'instrument', 'done');
  await fx.apply.recover(fx.doc);

  let doc = await fx.store.read('7', fx.doc.id);
  const receipt = doc.operations[0].receipt;

  assert.equal(receipt.stage.sequence, 3);
  await fx.rewind('instrument', 'Другое действие человека');
  doc = await fx.store.read('7', fx.doc.id);
  await assert.rejects(fx.apply.validateResume(doc, {
    applyOperationId: doc.operations[0].id,
    acceptedEvent: receipt.stage,
    expectedCurrentStage: receipt.stage,
  }), { code: 'stale_resume' });
  assert.equal(fx.gotoCalls(), 0);
  assert.equal(fx.resumeCalls(), 0);
});
