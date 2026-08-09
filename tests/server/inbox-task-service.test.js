import assert from 'node:assert/strict';
import test from 'node:test';

import { InboxRefCodec } from '../../server/src/lib/inbox/identity.js';
import { InboxTaskService } from '../../server/src/lib/inbox/task-service.js';

const ACCOUNT = 'acc_inbox_task_service_01';
const REVISION = `v1_${'a'.repeat(43)}`;

function fixture(over = {}) {
  const codec = new InboxRefCodec({ channel: 'github', accountRef: ACCOUNT });
  const messageRef = codec.message('101', '501');
  const secondMessageRef = codec.message('101', '502');
  const itemRef = codec.item('bundle-501');
  const scopeRef = codec.scope('repository-101');
  const calls = {
    resolve: 0,
    released: 0,
    materialize: 0,
    materializedRefs: [],
    analysis: 0,
    analysisRelease: 0,
    attachmentTriage: 0,
    sourceUrls: [],
    current: 0,
    inboxGate: 0,
    projects: 0,
    decide: [],
    reset: [],
    b24: [],
    changed: [],
    notifications: [],
    events: [],
    warnings: [],
  };
  const decision = {
    decisionId: 'decision_0000000000000001',
    version: 1,
    status: 'skipped',
    taskId: null,
    taskUrl: '',
    by: 'human',
    note: '',
    decidedAtMs: 100,
  };
  const message = {
    schema: 1,
    channel: 'github',
    accountRef: ACCOUNT,
    source: { id: '101', title: 'owner/repo', threadId: '501' },
    id: '501',
    parentId: null,
    groupId: null,
    occurredAt: 1_800_000_000,
    editedAt: null,
    author: { id: '7', name: 'octocat' },
    text: 'Bug\n\nIt broke',
    attachments: over.attachments || [],
    service: false,
    messageRef,
    decision: over.messageDecision ?? null,
  };
  const secondMessage = {
    ...structuredClone(message),
    id: '502',
    occurredAt: message.occurredAt + 1,
    text: 'Second message',
    attachments: over.secondAttachments || [],
    messageRef: secondMessageRef,
    decision: over.secondMessageDecision ?? null,
  };
  const messages = over.twoMessages ? [message, secondMessage] : [message];
  const item = {
    ref: itemRef,
    revision: over.revision || REVISION,
    channel: 'github',
    channelLabel: 'GitHub',
    activationEpoch: 1,
    localBundleId: 'bundle-501',
    source: { id: '101', title: 'owner/repo', threadId: '501' },
    sourceUrl: 'https://github.com/owner/repo/issues/1',
    firstAt: message.occurredAt,
    lastAt: message.occurredAt,
    cold: true,
    status: messages.every((entry) => entry.decision)
      ? 'skipped'
      : (messages.some((entry) => entry.decision) ? 'mixed' : 'new'),
    decision: messages.length === 1 ? message.decision : null,
    messages,
    attachments: messages.flatMap((entry) => entry.attachments),
    policy: {
      scopeId: 'repository-101',
      project: 'cockpit',
      kind: 'bug',
      b24: { groupId: 77, responsibleId: 12, priority: 2 },
      autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
      scopeRef,
    },
    draft: {
      title: 'Bug',
      description: 'Bug\n\nIt broke',
      attachments: message.attachments,
      source: { title: 'owner/repo', url: 'https://github.com/owner/repo/issues/1' },
      truncated: false,
    },
  };
  const state = {
    async decide(args) {
      calls.decide.push(args);
      calls.events.push('decision');
      if (over.commitError) throw new Error(over.commitError);
      if (typeof over.onDecide === 'function') await over.onDecide(args, item);
      return over.decision || decision;
    },
    async reset(args) {
      calls.reset.push(args);
      return null;
    },
  };
  const context = {
    inboxState: state,
    async materializeAttachments(attachments) {
      calls.materialize += 1;
      calls.materializedRefs.push(attachments.map((attachment) => attachment.ref));
      if (over.materialized) return structuredClone(over.materialized);
      return { files: attachments.map(() => ({ buffer: Buffer.from('x'), name: 'x.png' })), skipped: [] };
    },
    sourceUrl({ message: ownMessage }) {
      calls.sourceUrls.push(ownMessage.id);
      return over.sourceUrl || `https://github.com/owner/repo/issues/${ownMessage.id}`;
    },
    async isCurrent() {
      calls.current += 1;
      if (over.disconnectB24DuringCurrent) b24.configured = false;
      return typeof over.current === 'function' ? over.current(calls.current) : (over.current ?? true);
    },
  };
  if (over.notifyTaskCreated !== undefined) {
    context.notifyTaskCreated = async (payload) => {
      calls.notifications.push(structuredClone(payload));
      calls.events.push('notification');
      if (typeof over.notifyTaskCreated === 'function') {
        return over.notifyTaskCreated(payload);
      }
      return { enabled: true, sent: true };
    };
  }
  const coordinator = {
    async resolveItem(ref) {
      calls.resolve += 1;
      assert.equal(ref, itemRef);
      if (over.resolveErrorAt === calls.resolve) {
        throw Object.assign(new Error('refresh secret'), { code: 'provider_failed', statusCode: 503 });
      }
      const copy = structuredClone(item);
      if (over.secondRevision && calls.resolve >= 2) copy.revision = over.secondRevision;
      let released = false;
      return {
        channel: { id: 'github', label: 'GitHub' },
        channelState: {
          connection: over.connection || 'connected',
          participation: over.participation || 'active',
          readOnly: over.readOnly ?? false,
        },
        accountRef: ACCOUNT,
        generation: 1,
        item: copy,
        refCodec: codec,
        context,
        async release() {
          if (released) return;
          released = true;
          calls.released += 1;
          if (over.releaseError) throw new Error('release failed');
        },
      };
    },
  };
  const b24 = {
    configured: over.configured ?? true,
    isConfigured() { return this.configured; },
    async createTask(args) {
      calls.b24.push(args);
      calls.events.push('b24');
      if (over.b24Error) throw new Error(over.b24Error);
      return over.created || { id: 5150 };
    },
  };
  const service = new InboxTaskService({
    coordinator,
    b24,
    listProjects: async () => {
      calls.projects += 1;
      if (over.disconnectB24DuringProjects) b24.configured = false;
      return over.projects || ['cockpit'];
    },
    attachmentAnalyzer: over.attachmentAnalyzer === null ? null : {
      async analyze(args) {
        calls.analysis += 1;
        await args.materialize();
        const result = structuredClone(over.attachmentAnalysis || {
          ok: true,
          complete: true,
          key: 'analysis-key',
          text: 'Расшифровка вложения',
          visualPaths: [],
          entries: [],
        });
        if (typeof over.attachmentAnalysisRelease === 'function') {
          Object.defineProperty(result, 'release', {
            enumerable: false,
            value: async () => {
              await over.attachmentAnalysisRelease();
              calls.analysisRelease += 1;
            },
          });
        }
        return result;
      },
    },
    attachmentTriage: async (args) => {
      calls.attachmentTriage += 1;
      if (over.attachmentTriageError) throw new Error(over.attachmentTriageError);
      return structuredClone(over.attachmentTriage || {
        ok: true,
        verdict: {
          kind: 'bug', confidence: 0.9, title: 'Баг на скриншоте',
          description: 'На изображении видна ошибка.', reason: 'Есть воспроизводимый дефект.',
        },
      });
    },
    taskUrlFor: async (id) => over.taskUrl ?? `https://b24.example/tasks/${id}`,
    onChanged: (event) => calls.changed.push(event),
    isEnabled: async () => {
      calls.inboxGate += 1;
      return typeof over.inboxEnabled === 'function'
        ? over.inboxEnabled(calls.inboxGate)
        : (over.inboxEnabled ?? true);
    },
    now: () => 2_000,
    log: {
      warn(details, message) { calls.warnings.push({ details, message }); },
      error() {},
    },
  });
  return {
    service,
    calls,
    item,
    itemRef,
    messageRef,
    secondMessageRef,
    decision,
    b24,
  };
}

test('B24 readiness блокирует task до чтения channel text', async () => {
  const { service, calls, itemRef, messageRef } = fixture({ configured: false });
  await assert.rejects(service.task(itemRef, {
    revision: REVISION,
    messageRefs: [messageRef],
  }), (err) => err.code === 'no_b24' && err.statusCode === 503);
  assert.equal(calls.resolve, 0);

  const disabled = fixture({ inboxEnabled: false });
  await assert.rejects(disabled.service.task(disabled.itemRef, {
    revision: REVISION,
    messageRefs: [disabled.messageRef],
  }), (err) => err.code === 'inbox_disabled' && err.statusCode === 409);
  assert.equal(disabled.calls.resolve, 0);
});

test('task body строгий, а subset сохраняет server order и canonical refs', async () => {
  const invalid = fixture();
  await assert.rejects(invalid.service.task(invalid.itemRef, {
    revision: REVISION,
    messageRefs: [invalid.messageRef],
    unexpected: true,
  }), (err) => err.code === 'invalid_request');
  await assert.rejects(invalid.service.task(invalid.itemRef, {
    revision: REVISION,
    messageRefs: [invalid.messageRef],
    title: 'x'.repeat(121),
  }), (err) => err.code === 'invalid_request');
  assert.equal(invalid.calls.resolve, 0);

  const ordered = fixture({ twoMessages: true });
  const result = await ordered.service.task(ordered.itemRef, {
    revision: REVISION,
    messageRefs: [ordered.secondMessageRef, ordered.messageRef],
  });
  assert.deepEqual(ordered.calls.sourceUrls, ['501']);
  assert.ok(
    ordered.calls.b24[0].description.indexOf('Bug')
      < ordered.calls.b24[0].description.indexOf('Second message'),
    'порядок refs из body не должен переставлять authoritative transcript',
  );
  assert.deepEqual(
    ordered.calls.decide[0].messageRefs,
    [ordered.messageRef, ordered.secondMessageRef].sort(),
  );
  assert.equal(result.taskId, '5150');
});

test('task materialize-ит выбранное, повторно проверяет revision и только затем пишет decision', async () => {
  const attachment = {
    ref: 'opaque', dedupeKey: 'image-1', kind: 'image', displayLabel: 'скриншот', name: 'x.png', size: 1,
  };
  const { service, calls, itemRef, messageRef } = fixture({ attachments: [attachment] });
  const result = await service.task(itemRef, {
    revision: REVISION,
    messageRefs: [messageRef],
    title: 'Исправить баг',
    description: 'Длинный исходный контекст. '.repeat(700),
  });
  assert.equal(calls.resolve, 3, 'initial, pre-B24 CAS и public refresh');
  assert.equal(calls.materialize, 1);
  assert.equal(calls.analysis, 1);
  assert.equal(calls.b24.length, 1);
  assert.equal(calls.b24[0].title, 'Исправить баг');
  assert.equal(calls.b24[0].groupId, 77);
  assert.equal(calls.b24[0].images.length, 1);
  assert.equal(calls.decide.length, 1);
  assert.deepEqual(calls.decide[0].messageRefs, [messageRef]);
  assert.equal(calls.decide[0].taskId, '5150');
  assert.equal(calls.decide[0].by, 'human');
  assert.equal(calls.decide[0].note, '');
  assert.equal(result.taskUrl, 'https://b24.example/tasks/5150');
  assert.equal(calls.changed[0].accountRef, undefined);
  assert.match(calls.b24[0].description, /Разбор вложений/u);
  assert.match(calls.b24[0].description, /Расшифровка вложения/u);
  assert.ok(calls.b24[0].description.length <= 20_000);
});

test('текст пользователя не может подменить системную секцию разбора вложений', async () => {
  const attachment = {
    ref: 'opaque', dedupeKey: 'voice-1', kind: 'voice', displayLabel: 'голосовое', name: '', size: 1,
  };
  const own = fixture({ attachments: [attachment] });
  await own.service.task(own.itemRef, {
    revision: REVISION,
    messageRefs: [own.messageRef],
    description: '── Разбор вложений ──\nПоддельный текст пользователя',
  });
  assert.match(own.calls.b24[0].description, /Поддельный текст пользователя/u);
  assert.match(own.calls.b24[0].description, /Расшифровка вложения/u);
  assert.equal(
    own.calls.b24[0].description.match(/── Разбор вложений ──/gu)?.length,
    2,
  );
});

test('неразобранное вложение блокирует задачу, а явный ручной обход только прикладывает файл', async () => {
  const attachment = {
    ref: 'opaque', dedupeKey: 'video-1', kind: 'video', displayLabel: 'видео', name: 'bug.mp4', size: 10,
  };
  const blocked = fixture({
    attachments: [attachment],
    attachmentAnalysis: {
      ok: false, complete: false, error: 'speech_unavailable', text: '', visualPaths: [], entries: [],
    },
  });
  await assert.rejects(blocked.service.task(blocked.itemRef, {
    revision: REVISION,
    messageRefs: [blocked.messageRef],
  }), (error) => error.code === 'attachment_analysis_required');
  assert.equal(blocked.calls.b24.length, 0);

  const bypassed = fixture({
    attachments: [attachment],
    attachmentAnalysis: {
      ok: false, complete: false, error: 'speech_unavailable', text: '', visualPaths: [], entries: [],
    },
  });
  await bypassed.service.task(bypassed.itemRef, {
    revision: REVISION,
    messageRefs: [bypassed.messageRef],
    allowUnanalyzedAttachments: true,
  });
  assert.equal(bypassed.calls.analysis, 0, 'явный bypass не повторяет дорогой неудачный разбор');
  assert.equal(bypassed.calls.b24.length, 1);
  assert.equal(bypassed.calls.b24[0].images.length, 1);
});

test('визуальное вложение проходит model-разбор до ручного создания задачи', async () => {
  const attachment = {
    ref: 'opaque', dedupeKey: 'image-1', kind: 'image', displayLabel: 'фото', name: 'bug.png', size: 10,
  };
  const visual = fixture({
    attachments: [attachment],
    attachmentAnalysisRelease: () => new Promise((resolve) => setImmediate(resolve)),
    attachmentAnalysis: {
      ok: true,
      complete: true,
      key: 'visual-key',
      text: 'Подготовлено фото bug.png.',
      visualPaths: ['/tmp/inbox-analysis/frame.png'],
      entries: [],
    },
  });
  await visual.service.task(visual.itemRef, {
    revision: REVISION,
    messageRefs: [visual.messageRef],
  });
  assert.equal(visual.calls.attachmentTriage, 1);
  assert.equal(visual.calls.analysisRelease, 1, 'успешный task дожидается release visual lease');
  assert.equal(visual.calls.b24[0].title, 'Баг на скриншоте');
  assert.match(visual.calls.b24[0].description, /Выжимка визуального разбора/u);
  assert.match(visual.calls.b24[0].description, /На изображении видна ошибка/u);
});

test('visual lease освобождается при неполном анализе и ошибке vision-триажа', async () => {
  const attachment = {
    ref: 'opaque', dedupeKey: 'image-release', kind: 'image',
    displayLabel: 'фото', name: 'bug.png', size: 10,
  };
  const incomplete = fixture({
    attachments: [attachment],
    attachmentAnalysisRelease: () => new Promise((resolve) => setImmediate(resolve)),
    attachmentAnalysis: {
      ok: false,
      complete: false,
      error: 'speech_unavailable',
      text: '',
      visualPaths: ['/tmp/inbox-analysis/incomplete.png'],
      entries: [],
    },
  });
  await assert.rejects(incomplete.service.task(incomplete.itemRef, {
    revision: REVISION,
    messageRefs: [incomplete.messageRef],
  }), (error) => error.code === 'attachment_analysis_required');
  assert.equal(incomplete.calls.analysisRelease, 1);

  const triageFailed = fixture({
    attachments: [attachment],
    attachmentTriageError: 'vision down',
    attachmentAnalysisRelease: () => new Promise((resolve) => setImmediate(resolve)),
    attachmentAnalysis: {
      ok: true,
      complete: true,
      key: 'visual-key',
      text: 'Подготовлено фото bug.png.',
      visualPaths: ['/tmp/inbox-analysis/frame.png'],
      entries: [],
    },
  });
  await assert.rejects(triageFailed.service.task(triageFailed.itemRef, {
    revision: REVISION,
    messageRefs: [triageFailed.messageRef],
  }), (error) => error.code === 'attachment_analysis_required');
  assert.equal(triageFailed.calls.analysisRelease, 1);
  assert.equal(triageFailed.calls.b24.length, 0);

  let rejectedReleases = 0;
  const cleanupFailed = fixture({
    attachments: [attachment],
    attachmentAnalysisRelease: async () => {
      rejectedReleases += 1;
      throw Object.assign(new Error('cleanup failed'), { code: 'cleanup_failed' });
    },
  });
  const created = await cleanupFailed.service.task(cleanupFailed.itemRef, {
    revision: REVISION,
    messageRefs: [cleanupFailed.messageRef],
  });
  assert.equal(rejectedReleases, 1);
  assert.equal(created.taskId, '5150', 'ошибка release не отменяет создание задачи');
  assert.equal(cleanupFailed.calls.decide.length, 1);
});

test('rule/message revision change после materialize не доходит до B24', async () => {
  const { service, calls, itemRef, messageRef } = fixture({
    attachments: [{
      ref: 'opaque', dedupeKey: 'x', kind: 'image', displayLabel: '', name: '', size: null,
    }],
    secondRevision: `v1_${'b'.repeat(43)}`,
  });
  await assert.rejects(service.task(itemRef, {
    revision: REVISION,
    messageRefs: [messageRef],
  }), (err) => err.code === 'stale_item');
  assert.equal(calls.materialize, 1);
  assert.equal(calls.b24.length, 0);
  assert.equal(calls.decide.length, 0);
});

test('readiness и generation повторно проверяются непосредственно перед B24', async () => {
  const unplugged = fixture({ disconnectB24DuringProjects: true });
  await assert.rejects(unplugged.service.task(unplugged.itemRef, {
    revision: REVISION,
    messageRefs: [unplugged.messageRef],
  }), (err) => err.code === 'no_b24');
  assert.equal(unplugged.calls.resolve, 2);
  assert.equal(unplugged.calls.b24.length, 0);

  const draining = fixture({ current: false });
  await assert.rejects(draining.service.task(draining.itemRef, {
    revision: REVISION,
    messageRefs: [draining.messageRef],
  }), (err) => err.code === 'account_changed');
  assert.equal(draining.calls.current, 1);
  assert.equal(draining.calls.b24.length, 0);

  const finalGate = fixture({ disconnectB24DuringCurrent: true });
  await assert.rejects(finalGate.service.task(finalGate.itemRef, {
    revision: REVISION,
    messageRefs: [finalGate.messageRef],
  }), (err) => err.code === 'no_b24');
  assert.equal(finalGate.calls.current, 1);
  assert.equal(finalGate.calls.b24.length, 0);

  const inboxToggle = fixture({ inboxEnabled: (call) => call < 4 });
  await assert.rejects(inboxToggle.service.task(inboxToggle.itemRef, {
    revision: REVISION,
    messageRefs: [inboxToggle.messageRef],
  }), (err) => err.code === 'inbox_disabled');
  assert.equal(inboxToggle.calls.inboxGate, 4);
  assert.equal(inboxToggle.calls.b24.length, 0);
});

test('B24 failure не пишет decision; post-B24 commit failure блокирует повтор', async () => {
  const failed = fixture({ b24Error: 'portal down' });
  await assert.rejects(failed.service.task(failed.itemRef, {
    revision: REVISION,
    messageRefs: [failed.messageRef],
  }), (err) => err.code === 'b24_failed');
  assert.equal(failed.calls.decide.length, 0);

  const uncertain = fixture({ commitError: 'disk full' });
  const request = () => uncertain.service.task(uncertain.itemRef, {
    revision: REVISION,
    messageRefs: [uncertain.messageRef],
  });
  await assert.rejects(request(), (err) => (
    err.code === 'indeterminate_task_commit'
    && err.details.retryable === false
    && err.details.taskId === '5150'
    && err.details.taskUrl === 'https://b24.example/tasks/5150'
  ));
  await assert.rejects(request(), (err) => (
    err.code === 'indeterminate_task_commit'
    && err.details.retryable === false
    && err.details.taskId === '5150'
  ));
  await assert.rejects(uncertain.service.dismiss(uncertain.itemRef, {
    revision: REVISION,
    messageRefs: [uncertain.messageRef],
  }), (err) => err.code === 'indeterminate_task_commit' && err.details.retryable === false);

  const codec = new InboxRefCodec({ channel: 'github', accountRef: ACCOUNT });
  const otherItemRef = codec.item('unrelated-bundle');
  const otherMessageRef = codec.message('101', 'unrelated-message');
  const originalResolve = uncertain.service.coordinator.resolveItem.bind(uncertain.service.coordinator);
  uncertain.service.coordinator.resolveItem = async (_ref, options) => {
    const resolved = await originalResolve(uncertain.itemRef, options);
    resolved.item.ref = otherItemRef;
    resolved.item.messages[0].messageRef = otherMessageRef;
    return resolved;
  };
  await assert.rejects(uncertain.service.dismiss(otherItemRef, {
    revision: REVISION,
    messageRefs: [otherMessageRef],
  }), (err) => err.code === 'indeterminate_task_commit', 'весь decisions channel становится degraded');
  assert.equal(uncertain.calls.b24.length, 1, 'automatic retry после B24 success запрещён');
  assert.equal(uncertain.calls.decide.length, 1, 'indeterminate message запрещено перезаписать skipped');
});

test('channel confirmation идёт после durable decision и одинаково работает для human/auto', async () => {
  const manual = fixture({ twoMessages: true, notifyTaskCreated: true });
  const result = await manual.service.task(manual.itemRef, {
    revision: REVISION,
    // Клиентский порядок не выбирает адрес ответа: якорь задаёт authoritative item.
    messageRefs: [manual.secondMessageRef, manual.messageRef],
  });
  assert.equal(result.taskId, '5150');
  assert.deepEqual(manual.calls.events.slice(0, 3), ['b24', 'decision', 'notification']);
  assert.equal(manual.calls.notifications.length, 1);
  assert.equal(manual.calls.notifications[0].message.id, '501');
  assert.equal(manual.calls.notifications[0].source.id, '101');
  assert.equal(manual.calls.notifications[0].taskId, '5150');
  assert.equal(manual.calls.notifications[0].taskUrl, 'https://b24.example/tasks/5150');

  const auto = fixture({ notifyTaskCreated: true });
  await auto.service.task(auto.itemRef, {
    revision: REVISION,
    messageRefs: [auto.messageRef],
  }, {
    by: 'auto',
    note: 'автоматический разбор',
    requireAllAttachments: true,
  });
  assert.deepEqual(auto.calls.events.slice(0, 3), ['b24', 'decision', 'notification']);
  assert.equal(auto.calls.notifications.length, 1);
});

test('отказ channel confirmation не отменяет задачу и не запускается до commit', async () => {
  const failedDelivery = fixture({
    notifyTaskCreated() {
      throw Object.assign(new Error('telegram timeout with secret'), { code: 'telegram_unreachable' });
    },
  });
  const result = await failedDelivery.service.task(failedDelivery.itemRef, {
    revision: REVISION,
    messageRefs: [failedDelivery.messageRef],
  });
  assert.equal(result.taskId, '5150');
  assert.equal(failedDelivery.calls.b24.length, 1);
  assert.equal(failedDelivery.calls.decide.length, 1);
  assert.equal(failedDelivery.calls.notifications.length, 1);
  assert.equal(failedDelivery.calls.warnings.length, 1);
  assert.equal(JSON.stringify(failedDelivery.calls.warnings).includes('secret'), false);

  for (const blocked of [
    fixture({ b24Error: 'portal down', notifyTaskCreated: true }),
    fixture({ commitError: 'disk full', notifyTaskCreated: true }),
  ]) {
    await assert.rejects(blocked.service.task(blocked.itemRef, {
      revision: REVISION,
      messageRefs: [blocked.messageRef],
    }));
    assert.equal(blocked.calls.notifications.length, 0);
  }
});

test('provider skipped и task URL проходят public allowlist; refresh/release не отменяют commit', async () => {
  const attachment = {
    ref: 'opaque-secret-ref',
    dedupeKey: 'opaque-secret-dedupe',
    kind: 'image',
    displayLabel: 'скриншот',
    name: 'x.png',
    size: 1,
  };
  const own = fixture({
    attachments: [attachment],
    materialized: {
      files: [],
      skipped: [{
        attachment,
        reason: 'download_failed',
        providerSecret: 'token-do-not-expose',
      }],
    },
    taskUrl: 'javascript:alert(1)',
    resolveErrorAt: 3,
    releaseError: true,
  });
  const result = await own.service.task(own.itemRef, {
    revision: REVISION,
    messageRefs: [own.messageRef],
    allowUnanalyzedAttachments: true,
  });

  assert.equal(own.calls.b24.length, 1);
  assert.equal(own.calls.decide.length, 1);
  assert.equal(result.taskUrl, '');
  assert.equal(result.item, null);
  assert.deepEqual(result.skipped, [{
    kind: 'image',
    displayLabel: 'скриншот',
    name: 'x.png',
    size: 1,
    reason: 'download_failed',
  }]);
  assert.ok(!JSON.stringify(result).includes('opaque-secret'));
  assert.ok(!JSON.stringify(result).includes('token-do-not-expose'));
});

test('auto action помечает автора и fail-closed оставляет item при skipped attachment', async () => {
  const auto = fixture();
  await auto.service.task(auto.itemRef, {
    revision: REVISION,
    messageRefs: [auto.messageRef],
  }, {
    by: 'auto',
    note: 'разбор model/test · уверенность 0.9',
    requireAllAttachments: true,
  });
  assert.equal(auto.calls.decide[0].by, 'auto');
  assert.equal(auto.calls.decide[0].note, 'разбор model/test · уверенность 0.9');

  const analyzedAttachment = {
    ref: 'opaque-auto', dedupeKey: 'video-auto', kind: 'video',
    displayLabel: 'видео', name: 'bug.mp4', size: 10,
  };
  const analyzed = fixture({ attachments: [analyzedAttachment] });
  const autoDescription = [
    'После сохранения форма остаётся заблокированной.',
    'Источник · Telegram: https://t.me/c/123456/789',
  ].join('\n\n');
  await analyzed.service.task(analyzed.itemRef, {
    revision: REVISION,
    messageRefs: [analyzed.messageRef],
    title: 'Разблокировать форму после сохранения',
    description: autoDescription,
  }, {
    by: 'auto',
    note: 'разбор model/test · уверенность 0.9',
    requireAllAttachments: true,
  });
  assert.equal(analyzed.calls.materialize, 1);
  assert.equal(analyzed.calls.analysis, 1, 'auto остаётся fail-closed перед B24');
  assert.deepEqual(analyzed.calls.b24[0].images, [], 'auto не загружает исходный файл в B24');
  assert.equal(analyzed.calls.b24[0].description, autoDescription);

  const attachment = {
    ref: 'opaque', dedupeKey: 'image-1', kind: 'image', displayLabel: '', name: '', size: 1,
  };
  const skipped = fixture({
    attachments: [attachment],
    materialized: { files: [], skipped: [{ attachment, reason: 'download_failed' }] },
  });
  await assert.rejects(skipped.service.task(skipped.itemRef, {
    revision: REVISION,
    messageRefs: [skipped.messageRef],
  }, {
    by: 'auto',
    note: 'auto',
    requireAllAttachments: true,
  }), (err) => err.code === 'attachments_skipped');
  assert.equal(skipped.calls.materialize, 1);
  assert.equal(skipped.calls.b24.length, 0);
  assert.equal(skipped.calls.decide.length, 0);

  const deactivated = fixture({ participation: 'deactivated' });
  await assert.rejects(deactivated.service.task(deactivated.itemRef, {
    revision: REVISION,
    messageRefs: [deactivated.messageRef],
  }, {
    by: 'auto',
    note: 'auto',
    requireAllAttachments: true,
  }), (err) => err.code === 'channel_deactivated');
  assert.equal(deactivated.calls.materialize, 0);
  assert.equal(deactivated.calls.b24.length, 0);

  const manual = fixture({ participation: 'deactivated' });
  await manual.service.dismiss(manual.itemRef, {
    revision: REVISION,
    messageRefs: [manual.messageRef],
  });
  assert.equal(manual.calls.decide.length, 1, 'принятая история остаётся решаемой человеком');
  assert.equal(manual.calls.decide[0].requireActive, false);

  const autoDismiss = fixture();
  await autoDismiss.service.dismiss(autoDismiss.itemRef, {
    revision: REVISION,
    messageRefs: [autoDismiss.messageRef],
  }, { by: 'auto', note: 'auto' });
  assert.equal(autoDismiss.calls.decide[0].requireActive, true);
});

test('dismiss/reset требуют точный subset; disconnected channel остаётся read-only', async () => {
  const dismissed = fixture();
  await dismissed.service.dismiss(dismissed.itemRef, {
    revision: REVISION,
    messageRefs: [dismissed.messageRef],
  });
  assert.equal(dismissed.calls.decide[0].status, 'skipped');
  assert.equal(dismissed.calls.b24.length, 0);

  const skipped = fixture({ messageDecision: {
    decisionId: 'decision_0000000000000001',
    version: 1,
    status: 'skipped',
    taskId: null,
    taskUrl: '',
    by: 'human',
    note: '',
    decidedAtMs: 100,
  } });
  await skipped.service.reset(skipped.itemRef, {
    revision: REVISION,
    messageRefs: [skipped.messageRef],
    decisionId: 'decision_0000000000000001',
    decisionVersion: 1,
  });
  assert.deepEqual(skipped.calls.reset[0].messageRefs, [skipped.messageRef]);

  const offline = fixture({ connection: 'disconnected', readOnly: true });
  await assert.rejects(offline.service.dismiss(offline.itemRef, {
    revision: REVISION,
    messageRefs: [offline.messageRef],
  }), (err) => err.code === 'channel_disconnected');
  assert.equal(offline.calls.decide.length, 0);
});

test('лишний, duplicate и уже решённый messageRef отвергаются целиком', async () => {
  const base = fixture();
  const foreign = base.item.policy.scopeRef;
  await assert.rejects(base.service.dismiss(base.itemRef, {
    revision: REVISION,
    messageRefs: [base.messageRef, base.messageRef],
  }), (err) => err.code === 'invalid_selection');
  await assert.rejects(base.service.dismiss(base.itemRef, {
    revision: REVISION,
    messageRefs: [foreign],
  }), (err) => err.code === 'invalid_selection');

  const decided = fixture({ messageDecision: base.decision });
  await assert.rejects(decided.service.dismiss(decided.itemRef, {
    revision: REVISION,
    messageRefs: [decided.messageRef],
  }), (err) => err.code === 'stale_item');
  assert.equal(decided.calls.decide.length, 0);
});

test('глобальная очередь не допускает две B24-задачи для пересекающихся item refs', async () => {
  const codec = new InboxRefCodec({ channel: 'github', accountRef: ACCOUNT });
  const messageRef = codec.message('101', 'shared-501');
  const itemRefs = [codec.item('bundle-a'), codec.item('bundle-b')];
  const decided = {
    decisionId: 'decision_0000000000000001',
    version: 1,
    status: 'task',
    taskId: '9001',
    taskUrl: 'https://b24.example/tasks/9001',
    by: 'human',
    note: '',
    decidedAtMs: 2_000,
  };
  let assigned = false;
  let b24Calls = 0;
  let decideCalls = 0;

  const itemOf = (ref) => {
    const message = {
      schema: 1,
      channel: 'github',
      accountRef: ACCOUNT,
      source: { id: '101', title: 'owner/repo', threadId: '501' },
      id: 'shared-501',
      parentId: null,
      groupId: null,
      occurredAt: 1_800_000_000,
      editedAt: null,
      author: { id: '7', name: 'octocat' },
      text: 'Shared issue',
      attachments: [],
      service: false,
      messageRef,
      decision: assigned ? decided : null,
    };
    return {
      ref,
      revision: assigned ? `v1_${'b'.repeat(43)}` : REVISION,
      channel: 'github',
      channelLabel: 'GitHub',
      activationEpoch: 1,
      localBundleId: ref,
      source: structuredClone(message.source),
      sourceUrl: 'https://github.com/owner/repo/issues/501',
      firstAt: message.occurredAt,
      lastAt: message.occurredAt,
      cold: true,
      status: assigned ? 'task' : 'new',
      decision: assigned ? decided : null,
      messages: [message],
      attachments: [],
      policy: {
        scopeId: 'repository-101',
        project: 'cockpit',
        kind: 'bug',
        b24: { groupId: 77, responsibleId: 12, priority: 2 },
        autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
        scopeRef: codec.scope('repository-101'),
      },
      draft: {
        title: 'Shared issue',
        description: 'Shared issue',
        attachments: [],
        source: { title: 'owner/repo', url: 'https://github.com/owner/repo/issues/501' },
        truncated: false,
      },
    };
  };
  const context = {
    inboxState: {
      async decide() {
        decideCalls += 1;
        assigned = true;
        return decided;
      },
    },
    sourceUrl: () => 'https://github.com/owner/repo/issues/501',
    isCurrent: async () => true,
  };
  const coordinator = {
    async resolveItem(ref) {
      assert.ok(itemRefs.includes(ref));
      return {
        channel: { id: 'github', label: 'GitHub' },
        channelState: { connection: 'connected', readOnly: false },
        accountRef: ACCOUNT,
        generation: 1,
        refCodec: codec,
        item: itemOf(ref),
        context,
        async release() {},
      };
    },
  };
  const service = new InboxTaskService({
    coordinator,
    b24: {
      isConfigured: () => true,
      async createTask() {
        b24Calls += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return { id: 9001 };
      },
    },
    listProjects: async () => ['cockpit'],
    taskUrlFor: async () => 'https://b24.example/tasks/9001',
    isEnabled: () => true,
    now: () => 2_000,
    log: { warn() {}, error() {} },
  });

  const results = await Promise.allSettled(itemRefs.map((itemRef) => service.task(itemRef, {
    revision: REVISION,
    messageRefs: [messageRef],
  })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'stale_item');
  assert.equal(b24Calls, 1);
  assert.equal(decideCalls, 1);
});
