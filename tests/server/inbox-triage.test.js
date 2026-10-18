import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildInboxAutoTask,
  buildInboxTriagePlanPrompt,
  buildInboxTriagePrompt,
  countInboxAutoTasks,
  decideInboxAutoAction,
  decideInboxAutoPlan,
  INBOX_TRIAGE_KINDS,
  INBOX_TRIAGE_LIMITS,
  loadInboxVisualInputs,
  normalizeInboxTriageModel,
  parseInboxTriagePlan,
  parseInboxTriageVerdict,
  resolveInboxTriageTarget,
  runInboxTriage,
} from '../../server/src/lib/inbox/triage.ts';

const T0 = 1_800_000_000;
const SCOPE = 'typed-scope-ref';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function visualFixture(t, name = 'frame-001.png', bytes = PNG) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-inbox-triage-'));
  const dir = path.join(root, 'inbox-attachment-analysis', 'aa', 'cache-key', 'visual');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { mediaDir: root, file };
}

const message = (over = {}) => ({
  schema: 1,
  channel: 'github',
  accountRef: 'acc_inbox_triage_0001',
  source: { id: 'native-repository-secret', title: 'owner/repo', threadId: 'native-issue-secret' },
  id: 'native-message-secret',
  parentId: null,
  groupId: null,
  occurredAt: T0,
  editedAt: null,
  author: { id: 'native-author-secret', name: 'Octocat' },
  text: 'Кнопка «Сохранить» не нажимается',
  attachments: [{
    ref: 'opaque-attachment-secret',
    dedupeKey: 'dedupe-secret',
    kind: 'image',
    displayLabel: 'скриншот',
    name: 'error.png',
    size: 42,
  }],
  service: false,
  messageRef: 'typed-message-ref',
  decision: null,
  ...over,
});

const item = (over = {}) => ({
  ref: 'typed-item-ref',
  revision: `v1_${'a'.repeat(43)}`,
  channel: 'github',
  channelLabel: 'GitHub Issues',
  source: { id: 'native-repository-secret', title: 'owner/repo', threadId: 'native-issue-secret' },
  firstAt: T0,
  lastAt: T0,
  cold: true,
  status: 'new',
  messages: [message()],
  policy: {
    kind: 'bug',
    scopeRef: SCOPE,
    autoTask: { enabled: true, minConfidence: 0.7, maxPerDay: 2 },
  },
  draft: {
    title: 'Кнопка «Сохранить» не нажимается',
    description: '[01.01.2027 00:00] Octocat: Кнопка «Сохранить» не нажимается',
  },
  ...over,
});

const verdict = (over = {}) => ({
  kind: 'bug',
  confidence: 0.9,
  title: 'Не работает сохранение',
  description: 'Кнопка сохранения не реагирует.',
  reason: 'Пользователь прямо описал поломку.',
  ...over,
});

test('triage model хранится строгой provider/model парой', () => {
  assert.deepEqual(normalizeInboxTriageModel({ provider: ' claude ', model: ' opus ' }), {
    provider: 'claude', model: 'opus',
  });
  for (const invalid of [null, {}, 'claude/opus', { provider: 'claude' }, {
    provider: 'x'.repeat(257), model: 'm',
  }]) {
    assert.equal(normalizeInboxTriageModel(invalid), null);
  }
});

test('prompt использует общий transcript и не выпускает native/attachment identity', () => {
  const prompt = buildInboxTriagePrompt(item(), {
    attachmentAnalysis: {
      text: 'Расшифровка голосового: сохранение зависает.',
      visualPaths: ['/tmp/grigdesk-triage/frame-001.jpg', 'relative-secret.jpg'],
    },
  });
  assert.match(prompt.system, /JSON/u);
  assert.match(prompt.user, /GitHub Issues/u);
  assert.match(prompt.user, /Octocat/u);
  assert.match(prompt.user, /скриншот error\.png/u);
  assert.match(prompt.user, /Расшифровка голосового/u);
  assert.match(prompt.user, /визуальные вложения и кадры видео: 1/u);
  assert.doesNotMatch(prompt.user, /\/tmp\/grigdesk-triage/u);
  assert.doesNotMatch(prompt.user, /relative-secret/u);
  const serialized = JSON.stringify(prompt);
  for (const secret of [
    'native-repository-secret',
    'native-issue-secret',
    'native-message-secret',
    'native-author-secret',
    'opaque-attachment-secret',
    'dedupe-secret',
  ]) assert.ok(!serialized.includes(secret), secret);
});

test('model verdict требует exact bounded schema и fail-closed confidence', () => {
  const body = JSON.stringify(verdict());
  assert.deepEqual(parseInboxTriageVerdict(body), verdict());
  assert.deepEqual(
    parseInboxTriageVerdict(`\`\`\`json\n${body}\n\`\`\``),
    verdict(),
  );
  assert.equal(parseInboxTriageVerdict(JSON.stringify({ ...verdict(), extra: true })), null);
  assert.equal(parseInboxTriageVerdict(JSON.stringify(verdict({ kind: 'question' }))), null);
  assert.equal(parseInboxTriageVerdict(JSON.stringify(verdict({ title: 'x'.repeat(121) }))), null);
  assert.equal(parseInboxTriageVerdict(JSON.stringify(verdict({ confidence: 95 }))).confidence, 0);
  assert.equal(parseInboxTriageVerdict(JSON.stringify(verdict({ confidence: '0.9' }))).confidence, 0);
  assert.deepEqual(INBOX_TRIAGE_KINDS, ['bug', 'wish', 'none']);
});

const conversation = (count) => item({
  messages: Array.from({ length: count }, (unused, index) => message({
    id: `native-message-${index + 1}`,
    occurredAt: T0 + index * 10,
    text: `Сообщение ${index + 1}`,
    attachments: [],
    messageRef: `typed-message-ref-${index + 1}`,
  })),
});

const statement = (messages, over = {}) => ({ ...verdict(over), messages });

test('план разбора нумерует сообщения и требует от модели распределить все номера', () => {
  const prompt = buildInboxTriagePlanPrompt(conversation(3));
  assert.equal(prompt.messageCount, 3);
  assert.equal(prompt.truncated, false);
  assert.match(prompt.system, /"statements"/u);
  assert.match(prompt.system, /каждый номер укажи ровно один раз/iu);
  assert.match(prompt.user, /Сообщений в обращении: 3/u);
  for (const number of ['#1 ', '#2 ', '#3 ']) assert.ok(prompt.user.includes(number), number);
  assert.doesNotMatch(JSON.stringify(prompt), /typed-message-ref|native-message/u);

  // Обрезанный хвост номеров не получает вовсе: сослаться на непрочитанное нельзя.
  const long = buildInboxTriagePlanPrompt(item({
    messages: Array.from({ length: 400 }, (unused, index) => message({
      id: `native-message-${index + 1}`,
      text: 'Очень длинное сообщение. '.repeat(40),
      attachments: [],
    })),
  }));
  assert.equal(long.truncated, true);
  assert.ok(long.messageCount < 400 && long.messageCount > 0);
  assert.match(long.user, new RegExp(`Показаны первые ${long.messageCount} сообщений из 400`, 'u'));
  assert.ok(long.user.includes(`#${long.messageCount} `));
  assert.ok(!long.user.includes(`#${long.messageCount + 1} `));
});

test('план принимает разбиение, отвергает пересечение и терпит непокрытые номера', () => {
  const parse = (statements, messageCount = 6) => parseInboxTriagePlan(
    JSON.stringify({ statements }),
    { messageCount },
  );

  // Ровно случай человека: 3 сообщения на одну задачу, болтовня, 2 на другую.
  const split = parse([
    statement([1, 2, 3]),
    statement([4], { kind: 'none', title: 'Болтовня' }),
    statement([5, 6], { title: 'Вторая задача' }),
  ]);
  assert.deepEqual(split.statements.map((entry) => entry.messages), [[1, 2, 3], [4], [5, 6]]);
  assert.deepEqual(
    { covered: split.covered, messageCount: split.messageCount },
    { covered: 6, messageCount: 6 },
  );
  assert.equal(split.statements[1].kind, 'none');

  // Номера возвращаются отсортированными: порядок сообщений задаёт карточка, не модель.
  assert.deepEqual(parse([statement([3, 1, 2])]).statements[0].messages, [1, 2, 3]);

  // Непокрытые номера законны — их сообщения останутся человеку.
  assert.equal(parse([statement([1, 2])]).covered, 2);

  // А вот пересечение и выход за диапазон отвергают ВЕСЬ план.
  assert.equal(parse([statement([1, 2]), statement([2, 3])]), null);
  assert.equal(parse([statement([0])]), null);
  assert.equal(parse([statement([7])]), null);
  assert.equal(parse([statement([1.5])]), null);
  assert.equal(parse([statement([])]), null);
  assert.equal(parse([{ ...verdict() }]), null, 'элемент без messages — не постановка');
  assert.equal(parse([statement([1], { kind: 'question' })]), null);
  assert.equal(parseInboxTriagePlan(JSON.stringify({ statements: [] }), { messageCount: 1 }), null);
  assert.equal(parseInboxTriagePlan(JSON.stringify(verdict()), { messageCount: 1 }), null);
  assert.equal(parse(
    Array.from({ length: INBOX_TRIAGE_LIMITS.statements + 1 }, (u, i) => statement([i + 1])),
    INBOX_TRIAGE_LIMITS.statements + 1,
  ), null);
});

test('ворота карточки общие, а уверенность и квота считаются по каждой постановке', () => {
  const card = conversation(4);
  const plan = {
    statements: [
      statement([1, 2]),
      statement([3], { confidence: 0.5 }),
      statement([4], { kind: 'none' }),
    ],
  };
  const outcome = decideInboxAutoPlan({ item: card, plan, nowMs: T0 * 1000 });
  assert.equal(outcome.action, 'run');
  assert.deepEqual(outcome.statements.map((entry) => entry.action), ['create', 'unsure', 'dismiss']);

  // maxPerDay=2 у фикстуры: третья задача подряд упирается в квоту и остаётся человеку.
  const three = { statements: [statement([1]), statement([2]), statement([3])] };
  assert.deepEqual(
    decideInboxAutoPlan({ item: card, plan: three, nowMs: T0 * 1000 })
      .statements.map((entry) => entry.action),
    ['create', 'create', 'limit'],
  );

  // Ворота карточки перекрывают план целиком и до перебора постановок.
  assert.equal(decideInboxAutoPlan({
    item: conversation(2), plan, nowMs: T0 * 1000 + 86_400_001,
  }).action, 'old');
  assert.equal(decideInboxAutoPlan({ item: card, plan: null, nowMs: T0 * 1000 }).action, 'unclear');
  assert.equal(decideInboxAutoPlan({ item: card, nowMs: T0 * 1000 }).action, 'judge');
});

test('auto decision соблюдает new/cold/24h/quota/confidence границы', () => {
  const decide = (ownItem = {}, ownVerdict, createdToday = 0, nowMs = T0 * 1000) => (
    decideInboxAutoAction({ item: item(ownItem), verdict: ownVerdict, createdToday, nowMs })
  );
  assert.equal(decide({ status: 'mixed' }).action, 'skip');
  assert.equal(decide({ cold: false }).action, 'wait');
  assert.equal(decide({ lastAt: T0 - 86_400 }).action, 'judge');
  assert.equal(decide({ lastAt: T0 - 86_401 }).action, 'old');
  assert.equal(decide({ policy: { ...item().policy, autoTask: {
    enabled: true, minConfidence: 0.7, maxPerDay: 0,
  } } }).action, 'limit');
  assert.equal(decide({}, verdict({ confidence: 0.69 })).action, 'unsure');
  assert.equal(decide({}, verdict({ confidence: 0.7 })).action, 'create');
  assert.equal(decide({}, verdict({ kind: 'none' })).action, 'dismiss');
  assert.equal(decide({}, { kind: 'bug', confidence: Number.NaN }).action, 'unclear');
});

test('rolling quota считает только auto task того же typed scope и включает ровно 24h', () => {
  const sinceMs = T0 * 1000;
  const decisions = [
    { status: 'task', by: 'auto', scopeRef: SCOPE, decidedAtMs: sinceMs },
    { status: 'task', by: 'human', scopeRef: SCOPE, decidedAtMs: sinceMs + 1 },
    { status: 'skipped', by: 'auto', scopeRef: SCOPE, decidedAtMs: sinceMs + 1 },
    { status: 'task', by: 'auto', scopeRef: 'other-account-scope', decidedAtMs: sinceMs + 1 },
    { status: 'task', by: 'auto', scopeRef: SCOPE, decidedAtMs: sinceMs - 1 },
  ];
  assert.equal(countInboxAutoTasks(decisions, { scopeRef: SCOPE, sinceMs }), 1);
});

test('auto task содержит только постановку модели и несрезаемую ссылку на источник', () => {
  const sourceUrl = 'https://t.me/c/123456/789';
  const built = buildInboxAutoTask({
    item: item({
      channel: 'telegram',
      channelLabel: 'Telegram',
      sourceUrl,
      draft: {
        title: 'fallback',
        description: 'Оригинал '.repeat(4_000),
        source: { url: sourceUrl },
      },
    }),
    verdict: verdict({ description: 'Выжимка модели' }),
  });
  assert.equal(built.title, 'Не работает сохранение');
  assert.equal(
    built.description,
    `Выжимка модели\n\nИсточник · Telegram: ${sourceUrl}`,
  );
  assert.doesNotMatch(built.description, /Оригинал|claude|Inbox|Разбор вложений/u);
});

test('run triage использует только isolated transport и передаёт visual байтами', async (t) => {
  const visual = await visualFixture(t);
  const calls = [];
  const output = await runInboxTriage({
    item: item(),
    attachmentAnalysis: {
      text: 'На кадре видна ошибка 500.',
      visualPaths: [visual.file],
    },
    modelRef: { provider: 'claude', model: 'opus' },
    config: { rootDir: '/workspace/secret', mediaDir: visual.mediaDir },
    modelsRegistry: async () => ({
      claude: [{ id: 'opus', inputModalities: ['text', 'image'] }],
    }),
    executorResolver: async () => ({
      untrustedInput: {
        text: true,
        images: true,
        maxImages: 20,
        mediaTypes: ['image/png'],
      },
      async runUntrusted(args) {
        calls.push(args);
        return { reply: JSON.stringify(verdict()) };
      },
    }),
  });
  assert.equal(output.ok, true);
  assert.deepEqual(output.verdict, verdict());
  assert.match(calls[0].message, /Кнопка «Сохранить»/u);
  assert.match(calls[0].message, /ошибка 500/u);
  assert.deepEqual(calls[0].images, [{ mediaType: 'image/png', data: PNG.toString('base64') }]);
  for (const forbidden of ['cwd', 'extraDirs', 'attachmentPaths', 'permissionMode', 'sessionId']) {
    assert.equal(Object.hasOwn(calls[0], forbidden), false, forbidden);
  }
  assert.doesNotMatch(calls[0].message, /cache-key|frame-001|\/workspace\/secret/u);

  assert.deepEqual(await runInboxTriage({ item: item(), modelRef: null }), {
    ok: false, error: 'no_model',
  });
});

test('visual loader разрешает только настоящие изображения внутри server-owned cache', async (t) => {
  const visual = await visualFixture(t);
  assert.deepEqual(await loadInboxVisualInputs([visual.file], {
    config: { mediaDir: visual.mediaDir },
  }), {
    ok: true,
    images: [{ mediaType: 'image/png', data: PNG.toString('base64') }],
  });

  const outside = path.join(visual.mediaDir, 'outside.png');
  await writeFile(outside, PNG);
  assert.deepEqual(await loadInboxVisualInputs([outside], {
    config: { mediaDir: visual.mediaDir },
  }), { ok: false, error: 'invalid_attachment_path' });

  const forged = await visualFixture(t, 'forged.png', Buffer.from('не картинка'));
  assert.deepEqual(await loadInboxVisualInputs([forged.file], {
    config: { mediaDir: forged.mediaDir },
  }), { ok: false, error: 'invalid_attachment_media' });
});

test('coding executor не является fallback, а media capability проверяется до запуска', async (t) => {
  const visual = await visualFixture(t);
  const registry = async () => ({ claude: [{ id: 'opus', inputModalities: ['text'] }] });

  assert.deepEqual(await resolveInboxTriageTarget({
    modelRef: { provider: 'claude', model: 'opus' },
    modelsRegistry: registry,
    executorResolver: async () => ({ run() {} }),
  }), { ok: false, error: 'unsafe_model_provider' });

  let runs = 0;
  const result = await runInboxTriage({
    item: item(),
    attachmentAnalysis: { visualPaths: [visual.file] },
    modelRef: { provider: 'claude', model: 'opus' },
    config: { mediaDir: visual.mediaDir },
    modelsRegistry: registry,
    executorResolver: async () => ({
      untrustedInput: { text: true, images: true, maxImages: 20, mediaTypes: ['image/png'] },
      async runUntrusted() { runs += 1; return { reply: JSON.stringify(verdict()) }; },
    }),
  });
  assert.deepEqual(result, { ok: false, error: 'unsupported_media' });
  assert.equal(runs, 0);
});
