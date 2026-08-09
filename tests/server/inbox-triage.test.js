import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildInboxAutoTask,
  buildInboxTriagePrompt,
  countInboxAutoTasks,
  decideInboxAutoAction,
  INBOX_TRIAGE_KINDS,
  loadInboxVisualInputs,
  normalizeInboxTriageModel,
  parseInboxTriageVerdict,
  resolveInboxTriageTarget,
  runInboxTriage,
} from '../../server/src/lib/inbox/triage.js';

const T0 = 1_800_000_000;
const SCOPE = 'typed-scope-ref';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function visualFixture(t, name = 'frame-001.png', bytes = PNG) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-inbox-triage-'));
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
      visualPaths: ['/tmp/cockpit-triage/frame-001.jpg', 'relative-secret.jpg'],
    },
  });
  assert.match(prompt.system, /JSON/u);
  assert.match(prompt.user, /GitHub Issues/u);
  assert.match(prompt.user, /Octocat/u);
  assert.match(prompt.user, /скриншот error\.png/u);
  assert.match(prompt.user, /Расшифровка голосового/u);
  assert.match(prompt.user, /визуальные вложения и кадры видео: 1/u);
  assert.doesNotMatch(prompt.user, /\/tmp\/cockpit-triage/u);
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
