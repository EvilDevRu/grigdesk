import assert from 'node:assert/strict';
import test from 'node:test';

import { InboxCoordinator } from '../../server/src/lib/inbox/coordinator.ts';
import { InboxRefCodec } from '../../server/src/lib/inbox/identity.ts';
import {
  createGitHubInboxChannel,
  GitHubInboxChannelError,
} from '../../server/src/lib/github/inboxChannel.ts';

const ACCOUNT_REF = 'acc_github_inbox_0001';
const REPOSITORY_ID = '123456';
const FULL_NAME = 'acme/support';
const CREATED_AT = '2026-08-09T12:34:56Z';
const OCCURRED_AT = Date.parse(CREATED_AT) / 1000;

const marker = (afterSeq, afterOccurredAt) => ({ schema: 1, afterSeq, afterOccurredAt });
const windows = (startSeq = 0, startAt = OCCURRED_AT - 1) => [
  { epoch: 1, startMarker: marker(startSeq, startAt), endMarker: null },
];

function issue({ id = 7654321, number = 91, createdAt = CREATED_AT, over = {} } = {}) {
  return {
    id,
    number,
    title: 'Не открывается форма',
    body: 'Секретный текст обращения',
    created_at: createdAt,
    html_url: `https://github.com/${FULL_NAME}/issues/${number}`,
    user: { id: 42, login: 'reporter' },
    ...over,
  };
}

function row({ seq = 1, snapshot = issue(), over = {} } = {}) {
  return {
    schemaVersion: 1,
    channel: 'github',
    accountRef: ACCOUNT_REF,
    seq,
    transport: { kind: 'webhook', id: `delivery-${seq}` },
    semanticKey: `semantic-${snapshot.id}`,
    repositoryId: REPOSITORY_ID,
    issueId: String(snapshot.id),
    occurredAt: Date.parse(snapshot.created_at) / 1000,
    firstSeq: seq,
    duplicateOfSeq: null,
    snapshot,
    ...over,
  };
}

function rule(over = {}) {
  return {
    repositoryId: REPOSITORY_ID,
    project: 'SUPPORT',
    kind: 'bug',
    b24: { responsibleId: null, groupId: null, priority: 1 },
    autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
    ...over,
  };
}

function inboxState({ activationWindows = windows(), persisted = null } = {}) {
  const refCodec = new InboxRefCodec({ channel: 'github', accountRef: ACCOUNT_REF });
  const state = persisted ?? {
    schemaVersion: 1,
    channel: 'github',
    accountRef: ACCOUNT_REF,
    activation: {
      version: 1,
      epochs: [{
        epoch: 1,
        startedAtMs: (OCCURRED_AT - 1) * 1000,
        startMarker: marker(0, OCCURRED_AT - 1),
        endedAtMs: null,
        endMarker: null,
        endReason: null,
      }],
    },
    updatedAtMs: (OCCURRED_AT - 1) * 1000,
    decisions: [],
  };
  return {
    refCodec,
    async read() { return structuredClone(state); },
    async summary() {
      return {
        participation: 'active', activationVersion: 1, currentEpoch: 1,
        startedAtMs: state.activation.epochs[0].startedAtMs,
        endedAtMs: null, endReason: null,
      };
    },
    async activationWindows() { return structuredClone(activationWindows); },
    async activate() {},
    async deactivate() {},
  };
}

/**
 * Синтетический lease читает настоящую политику канала без внешнего аккаунта.
 * Предикат удаления и паузы позволяют менять регистрацию на границе чтения.
 */
function harness({
  rows = [row()],
  repositoryRule = rule(),
  connection = 'connected',
  current = () => true,
  onHead = null,
  onList = null,
  nativeExtras = {},
  isProjectDeleted = () => false,
} = {}) {
  const counters = { acquire: 0, release: 0, rule: 0, head: 0, list: 0 };
  const stateStore = inboxState();
  const archive = {
    async head() {
      counters.head += 1;
      onHead?.();
      return rows.reduce((max, entry) => Math.max(max, entry.seq), 0);
    },
    async list({ afterSeq, throughSeq, limit }) {
      counters.list += 1;
      onList?.();
      const upper = throughSeq ?? Number.MAX_SAFE_INTEGER;
      return structuredClone(rows
        .filter((entry) => entry.seq > afterSeq && entry.seq <= upper)
        .slice(0, limit));
    },
  };
  const rules = {
    async ruleFor(repositoryId) {
      counters.rule += 1;
      assert.equal(repositoryId, REPOSITORY_ID);
      return repositoryRule === null ? null : structuredClone(repositoryRule);
    },
  };
  const capability = createGitHubInboxChannel({
    isProjectDeleted,
    enabled: async () => true,
    state: async () => ({
      connection,
      participation: 'active',
      reason: null,
      token: 'github_pat_секрет',
      secret: 'webhook-secret',
      repositoryId: REPOSITORY_ID,
      providerIdentity: [1, 'github.com', 'repository', REPOSITORY_ID],
    }),
    acquireInboxLease: async () => {
      counters.acquire += 1;
      return {
        accountRef: ACCOUNT_REF,
        generation: 'github-generation-1',
        context: {
          repositoryId: REPOSITORY_ID,
          repositoryFullName: FULL_NAME,
          archive,
          rules,
          inboxState: stateStore,
          token: 'github_pat_секрет',
          webhookSecret: 'webhook-secret',
          ...nativeExtras,
        },
        isCurrent: current,
        release() { counters.release += 1; },
      };
    },
  });
  return { capability, counters, archive, rules, inboxState: stateStore };
}

test('capability объявляет GitHub Issues и exact atomic grouping', async () => {
  const { capability } = harness();
  assert.equal(capability.id, 'github');
  assert.equal(capability.label, 'GitHub Issues');
  assert.equal(capability.grouping.settleMs, 0);
  assert.deepEqual(
    capability.grouping.bundleKeyOf({ channel: 'github', id: '7654321' }),
    { kind: 'issue', id: '7654321' },
  );
  assert.equal(await capability.enabled(), true);
});

test('state имеет fixed projection без credentials, generation и provider identity', async () => {
  const { capability } = harness();
  const state = await capability.state();
  assert.deepEqual(state, {
    connection: 'connected',
    participation: 'active',
    reason: null,
  });
  const serialized = JSON.stringify(state);
  for (const forbidden of ['github_pat_', 'webhook-secret', REPOSITORY_ID, 'providerIdentity']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('authorized archive row становится ровно одним batch с repository policy', async () => {
  const { capability, counters } = harness();
  const context = await capability.acquireInboxContext();
  try {
    const batches = await context.listAuthorizedBatches({
      nowMs: (OCCURRED_AT + 1) * 1000,
      limit: 100,
      activationWindows: windows(),
    });
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0], {
      activationEpoch: 1,
      source: { id: REPOSITORY_ID, title: FULL_NAME, threadId: '7654321' },
      messages: [{
        schema: 1,
        channel: 'github',
        accountRef: ACCOUNT_REF,
        source: { id: REPOSITORY_ID, title: FULL_NAME, threadId: '7654321' },
        id: '7654321',
        parentId: null,
        groupId: null,
        occurredAt: OCCURRED_AT,
        editedAt: null,
        author: { id: '42', name: 'reporter' },
        text: 'Не открывается форма\n\nСекретный текст обращения',
        attachments: [],
        service: false,
      }],
      policy: {
        scopeId: REPOSITORY_ID,
        project: 'SUPPORT',
        kind: 'bug',
        b24: { responsibleId: null, groupId: null, priority: 1 },
        autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
      },
      truncated: false,
    });
    assert.equal(context.sourceUrl({ source: batches[0].source, message: batches[0].messages[0] }),
      'https://github.com/acme/support/issues/91');
    assert.deepEqual(await context.materializeAttachments([]), { files: [], skipped: [] });
    assert.equal(counters.rule, 1);
    assert.equal(counters.list, 1);
  } finally {
    await context.release();
    await context.release();
  }
  assert.equal(counters.release, 1, 'flattened release идемпотентен');
});

test('source URL не доверяет подменённому native html_url и строится из verified fullName', async () => {
  const malicious = issue({
    over: { html_url: 'https://evil.example/steal?token=secret' },
  });
  const { capability } = harness({ rows: [row({ snapshot: malicious })] });
  const context = await capability.acquireInboxContext();
  try {
    const [batch] = await context.listAuthorizedBatches({
      nowMs: (OCCURRED_AT + 1) * 1000,
      limit: 10,
      activationWindows: windows(),
    });
    assert.equal(context.sourceUrl({ source: batch.source, message: batch.messages[0] }),
      'https://github.com/acme/support/issues/91');
    assert.throws(
      () => context.sourceUrl({ source: batch.source, message: { ...batch.messages[0], id: 'other' } }),
      (error) => error.code === 'github_inbox_invalid_source',
    );
  } finally {
    await context.release();
  }
});

test('пустой allowlist не читает archive и не публикует сохранённый text', async () => {
  const { capability, counters } = harness({
    repositoryRule: null,
    onList() { throw new Error('archive text не должен читаться'); },
  });
  const context = await capability.acquireInboxContext();
  try {
    assert.deepEqual(await context.listAuthorizedBatches({
      nowMs: (OCCURRED_AT + 1) * 1000,
      limit: 100,
      activationWindows: windows(),
    }), []);
    assert.equal(counters.rule, 1);
    assert.equal(counters.list, 0);
  } finally {
    await context.release();
  }
});

test('activation windows исключают history, exact boundary и gap', async () => {
  const at = (seconds) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
  const rows = [
    row({ seq: 10, snapshot: issue({ id: 100, number: 10, createdAt: at(100) }) }),
    row({ seq: 11, snapshot: issue({ id: 101, number: 11, createdAt: at(100) }) }),
    row({ seq: 12, snapshot: issue({ id: 102, number: 12, createdAt: at(101) }) }),
    row({ seq: 21, snapshot: issue({ id: 103, number: 13, createdAt: at(201) }) }),
    row({ seq: 31, snapshot: issue({ id: 104, number: 14, createdAt: at(150) }) }),
    row({ seq: 32, snapshot: issue({ id: 105, number: 15, createdAt: at(301) }) }),
  ];
  const activationWindows = [
    { epoch: 1, startMarker: marker(10, 100), endMarker: marker(20, 200) },
    { epoch: 2, startMarker: marker(30, 300), endMarker: null },
  ];
  const { capability } = harness({ rows });
  const context = await capability.acquireInboxContext();
  try {
    const batches = await context.listAuthorizedBatches({
      nowMs: 400_000,
      limit: 100,
      activationWindows,
    });
    assert.deepEqual(batches.map((batch) => [batch.messages[0].id, batch.activationEpoch]), [
      ['102', 1],
      ['105', 2],
    ]);
  } finally {
    await context.release();
  }
});

test('один issue на batch и limit дают явный truncated', async () => {
  const second = issue({ id: 7654322, number: 92, createdAt: '2026-08-09T12:34:57Z' });
  const { capability } = harness({ rows: [row(), row({ seq: 2, snapshot: second })] });
  const context = await capability.acquireInboxContext();
  try {
    const batches = await context.listAuthorizedBatches({
      nowMs: (OCCURRED_AT + 2) * 1000,
      limit: 1,
      activationWindows: windows(),
    });
    assert.equal(batches.length, 1);
    assert.equal(batches[0].messages.length, 1);
    assert.equal(batches[0].truncated, true);
  } finally {
    await context.release();
  }
});

test('scan budget больше public max исчерпывающе page-ит GitHub archive', async () => {
  const rows = Array.from({ length: 1001 }, (_, index) => row({
    seq: index + 1,
    snapshot: issue({
      id: 7_700_000 + index,
      number: 1_000 + index,
    }),
  }));
  const { capability, counters } = harness({ rows });
  const context = await capability.acquireInboxContext();
  try {
    const batches = await context.listAuthorizedBatches({
      nowMs: (OCCURRED_AT + 1) * 1000,
      limit: 10_000,
      activationWindows: windows(),
    });
    assert.equal(batches.length, 1001);
    assert.equal(batches.some((entry) => entry.truncated), false);
    assert.equal(counters.list, 2);
  } finally {
    await context.release();
  }
});

test('activation marker берёт archive head и server now под generation checks', async () => {
  const { capability, counters } = harness({ rows: [row({ seq: 7 })] });
  const context = await capability.acquireInboxContext();
  try {
    assert.deepEqual(await context.createActivationMarker({ nowMs: 12_999 }), marker(7, 12));
    assert.equal(counters.head, 1);
  } finally {
    await context.release();
  }
});

test('stale generation до выдачи context fail-closed и освобождает lease', async () => {
  const { capability, counters } = harness({ current: () => false });
  await assert.rejects(
    () => capability.acquireInboxContext(),
    (error) => error instanceof GitHubInboxChannelError
      && error.code === 'stale_generation'
      && error.statusCode === 409,
  );
  assert.equal(counters.release, 1);
});

test('generation switch во время archive read отбрасывает поздний результат', async () => {
  let live = true;
  const { capability } = harness({
    current: () => live,
    onList() { live = false; },
  });
  const context = await capability.acquireInboxContext();
  try {
    await assert.rejects(
      () => context.listAuthorizedBatches({
        nowMs: (OCCURRED_AT + 1) * 1000,
        limit: 100,
        activationWindows: windows(),
      }),
      (error) => error.code === 'stale_generation' && error.statusCode === 409,
    );
  } finally {
    await context.release();
  }
});

test('generation switch во время marker head не создаёт activation boundary', async () => {
  let live = true;
  const { capability } = harness({
    current: () => live,
    onHead() { live = false; },
  });
  const context = await capability.acquireInboxContext();
  try {
    await assert.rejects(
      () => context.createActivationMarker({ nowMs: 12_999 }),
      (error) => error.code === 'stale_generation',
    );
  } finally {
    await context.release();
  }
});

test('disconnected selected account читается через offline lease и остаётся public read-only', async () => {
  const { capability, counters } = harness({
    connection: 'disconnected',
    nativeExtras: { providerToken: 'github_pat_never_public' },
  });
  const coordinator = new InboxCoordinator({ channels: [capability] });
  const result = await coordinator.list({ nowMs: (OCCURRED_AT + 1) * 1000 });

  assert.equal(counters.acquire, 1, 'disconnected state не блокирует injected offline lease');
  assert.equal(result.items.length, 1);
  assert.equal(result.channels[0].connection, 'disconnected');
  assert.equal(result.channels[0].readOnly, true);
  assert.deepEqual(Object.keys(result.items[0].source).sort(), ['title', 'url']);
  const serialized = JSON.stringify(result);
  for (const forbidden of [ACCOUNT_REF, REPOSITORY_ID, 'github_pat_', 'webhook-secret']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} не должен попасть в public DTO`);
  }
});

test('flattened coordinator context не выставляет repository identity или credentials', async () => {
  const { capability } = harness();
  const context = await capability.acquireInboxContext();
  try {
    const keys = Object.keys(context);
    for (const forbidden of [
      'repositoryId', 'repositoryFullName', 'token', 'secret', 'webhookSecret', 'providerIdentity',
    ]) assert.equal(keys.includes(forbidden), false);
  } finally {
    await context.release();
  }
});


test('PD-reconnect: tombstone не получает эффективную политику после подключения', async () => {
  const { capability, counters, rules } = harness({
    isProjectDeleted: (id) => id === 'SUPPORT',
  });
  const before = await rules.ruleFor(REPOSITORY_ID);
  const context = await capability.acquireInboxContext();

  try {
    const batches = await context.listAuthorizedBatches({

      nowMs: (OCCURRED_AT + 1) * 1000,
      limit: 100,
      activationWindows: windows(),

    });

    assert.deepEqual(batches, []);
    assert.equal(counters.list, 0, 'tombstone проверяется до чтения текста');
    assert.deepEqual(await rules.ruleFor(REPOSITORY_ID), before);
  } finally {
    context.release();
  }
});

test('PD-policy-race: удаление во время чтения не выдаёт batch', async () => {
  let deleted = false;
  const { capability } = harness({
    isProjectDeleted: () => deleted,
    onList: () => {
      deleted = true;
    },
  });
  const context = await capability.acquireInboxContext();

  try {
    assert.deepEqual(await context.listAuthorizedBatches({

      nowMs: (OCCURRED_AT + 1) * 1000,
      limit: 100,
      activationWindows: windows(),

    }), []);
  } finally {
    context.release();
  }
});

test('PD-reconnect: ошибка предиката закрывает эффективную политику', async () => {
  const { capability } = harness({
    isProjectDeleted: () => {
      throw new Error('prefs повреждены');
    },
  });
  const context = await capability.acquireInboxContext();

  try {
    await assert.rejects(context.listAuthorizedBatches({

      nowMs: (OCCURRED_AT + 1) * 1000,
      limit: 100,
      activationWindows: windows(),

    }), { code: 'github_inbox_invalid_policy' });
  } finally {
    context.release();
  }
});
