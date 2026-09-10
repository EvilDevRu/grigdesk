import assert from 'node:assert/strict';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  InboxAttachmentAnalyzer,
  INBOX_ATTACHMENT_ANALYSIS_LIMITS,
} from '../../server/src/lib/inbox/attachmentAnalysis.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function attachment(index, over = {}) {
  return {
    ref: `opaque-ref-${index}`,
    dedupeKey: `opaque-dedupe-${index}`,
    kind: 'voice',
    displayLabel: 'голосовое сообщение',
    name: `voice-${index}.ogg`,
    size: 10,
    messageId: `native-message-${index}`,
    groupId: null,
    ...over,
  };
}

function item(attachments, over = {}) {
  return {
    ref: 'typed-item-secret',
    revision: `v1_${'a'.repeat(43)}`,
    channel: 'telegram',
    accountRef: 'account-secret',
    messages: [{
      id: 'native-message-secret',
      messageRef: 'typed-message-secret',
      editedAt: null,
      occurredAt: 1_800_000_000,
      attachments,
    }],
    attachments,
    ...over,
  };
}

async function fixture(t, dependencies = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-inbox-attachment-analysis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, 'cache');
  return {
    root,
    cacheDir,
    analyzer: new InboxAttachmentAnalyzer({ cacheDir, ...dependencies }),
  };
}

async function cacheFiles(cacheDir, key) {
  const bucket = path.join(cacheDir, key.slice(0, 2));
  try {
    return (await readdir(bucket, { recursive: true })).map(String).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function assertTempClean(cacheDir) {
  const temp = path.join(cacheDir, '.tmp');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const names = await readdir(temp);
      if (names.length === 0) return;
      await new Promise((resolve) => setImmediate(resolve));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
  assert.deepEqual(await readdir(temp), []);
}

test('voice транскрибируется, кэшируется atomically и не публикует opaque identity', async (t) => {
  let transcribeCalls = 0;
  let materializeCalls = 0;
  const source = attachment(1, {
    ref: 'opaque-ref-never-publish',
    dedupeKey: 'opaque-dedupe-never-publish',
    name: '../../voice secret.ogg',
  });
  const ownItem = item([source]);
  const first = await fixture(t, {
    async transcribe({ filePath, signal }) {
      transcribeCalls += 1;
      assert.equal(signal instanceof AbortSignal, true);
      assert.ok(!path.basename(filePath).includes('..'));
      await access(filePath);
      return { transcript: { segments: [{ text: '  Кнопка не работает.  ' }] } };
    },
  });
  const result = await first.analyzer.analyze({
    item: ownItem,
    async materialize() {
      materializeCalls += 1;
      return {
        files: [{
          index: 0,
          buffer: Buffer.from('voice'),
          name: source.name,
          kind: source.kind,
          displayLabel: source.displayLabel,
        }],
        skipped: [],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.match(result.key, /^[a-f0-9]{64}$/u);
  assert.match(result.text, /Кнопка не работает/u);
  assert.equal(result.entries[0].name, 'voice secret.ogg');
  assert.equal(result.entries[0].status, 'ready');
  assert.deepEqual(result.visualPaths, []);
  assert.equal(transcribeCalls, 1);
  assert.equal(materializeCalls, 1);

  const names = await cacheFiles(first.cacheDir, result.key);
  assert.deepEqual(names.filter((name) => name.endsWith('.json')), [`${result.key}.json`]);
  assert.ok(names.every((name) => !name.endsWith('.tmp')));
  const cache = await readFile(
    path.join(first.cacheDir, result.key.slice(0, 2), `${result.key}.json`),
    'utf8',
  );
  for (const secret of [source.ref, source.dedupeKey, ownItem.ref, ownItem.messages[0].id]) {
    assert.ok(!cache.includes(secret), secret);
  }

  const cold = new InboxAttachmentAnalyzer({
    cacheDir: first.cacheDir,
    transcribe: async () => assert.fail('cold cache не должен запускать Whisper'),
  });
  const cached = await cold.analyze({
    item: ownItem,
    materialize: async () => assert.fail('cold cache не должен скачивать файл'),
  });
  assert.deepEqual(cached, result);
  await assertTempClean(first.cacheDir);
});

test('одинаковый fingerprint дедуплицирует concurrent materialize и transcribe', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let materializeCalls = 0;
  let transcribeCalls = 0;
  const source = attachment(1, { kind: 'audio', displayLabel: 'аудио', name: 'sound.mp3' });
  const own = await fixture(t, {
    async transcribe() {
      transcribeCalls += 1;
      return { text: 'один результат' };
    },
  });
  const materialize = async () => {
    materializeCalls += 1;
    markStarted();
    await gate;
    return {
      files: [{ index: 0, buffer: Buffer.from('audio'), ...source }],
      skipped: [],
    };
  };

  const first = own.analyzer.analyze({ item: item([source]), materialize });
  const second = own.analyzer.analyze({ item: item([source]), materialize });
  await started;
  assert.equal(materializeCalls, 1);
  release();
  assert.deepEqual(await first, await second);
  assert.equal(materializeCalls, 1);
  assert.equal(transcribeCalls, 1);
});

test('лимиты 12 файлов и 80 МБ срабатывают до lazy materialize', async (t) => {
  const own = await fixture(t);
  let materializeCalls = 0;
  const materialize = async () => {
    materializeCalls += 1;
    return { files: [], skipped: [] };
  };

  const tooMany = Array.from({ length: INBOX_ATTACHMENT_ANALYSIS_LIMITS.files + 1 }, (_, index) => (
    attachment(index)
  ));
  const manyResult = await own.analyzer.analyze({ item: item(tooMany), materialize });
  assert.equal(manyResult.ok, false);
  assert.equal(manyResult.complete, false);
  assert.match(manyResult.entries[0].reason, /12/u);

  const tooLarge = [
    attachment(20, { size: 50 * 1024 * 1024 }),
    attachment(21, { size: 31 * 1024 * 1024 }),
  ];
  const largeResult = await own.analyzer.analyze({
    item: item(tooLarge, { revision: `v1_${'b'.repeat(43)}` }),
    materialize,
  });
  assert.equal(largeResult.ok, false);
  assert.match(largeResult.entries[0].reason, /80 МБ/u);
  assert.equal(materializeCalls, 0);
});

test('video без аудио считается полным при безопасно извлечённых кадрах', async (t) => {
  const source = attachment(1, {
    kind: 'video_note',
    displayLabel: 'видеосообщение',
    name: '../../../circle.webm',
  });
  let sourcePath = '';
  const own = await fixture(t, {
    async transcribe({ filePath }) {
      sourcePath = filePath;
      throw Object.assign(new Error('В файле нет аудио-дорожки'), { code: 'no_audio' });
    },
    async extractFrames({ filePath, destDir, maxFrames, signal }) {
      assert.equal(filePath, sourcePath);
      assert.equal(maxFrames, INBOX_ATTACHMENT_ANALYSIS_LIMITS.frames);
      assert.equal(signal instanceof AbortSignal, true);
      const frame = path.join(destDir, 'frame-001.png');
      await writeFile(frame, PNG);
      return [frame, path.join(own.root, 'outside-secret.jpg')];
    },
  });
  const result = await own.analyzer.analyze({
    item: item([source]),
    materialize: async () => ({
      files: [{ index: 0, buffer: Buffer.from('video'), ...source }],
      skipped: [],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.visualPaths.length, 1);
  assert.match(path.basename(result.visualPaths[0]), /^[a-f0-9]{64}\.png$/u);
  assert.ok(!result.visualPaths[0].includes('circle'));
  await access(result.visualPaths[0]);
  assert.match(result.entries[0].reason, /Аудиодорожка отсутствует/u);
  await assertTempClean(own.cacheDir);
});

test('raster image/document/sticker дают visualPaths, а UTF-8 document — bounded text', async (t) => {
  const attachments = [
    attachment(1, { kind: 'image', displayLabel: 'фото', name: '../shot.png' }),
    attachment(2, { kind: 'document', displayLabel: 'файл', name: 'scan.jpeg' }),
    attachment(3, { kind: 'sticker', displayLabel: 'стикер', name: 'look.webp' }),
    attachment(4, { kind: 'document', displayLabel: 'файл', name: 'report.md' }),
  ];
  const own = await fixture(t);
  const result = await own.analyzer.analyze({
    item: item(attachments),
    materialize: async () => ({
      files: [
        { index: 0, buffer: PNG, ...attachments[0] },
        { index: 1, buffer: PNG, ...attachments[1] },
        { index: 2, buffer: PNG, ...attachments[2] },
        { index: 3, buffer: Buffer.from('# Ошибка\nСохранение не работает.', 'utf8'), ...attachments[3] },
      ],
      skipped: [],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.visualPaths.length, 3);
  assert.deepEqual(result.entries.map((entryValue) => entryValue.name), [
    'shot.png', 'scan.jpeg', 'look.webp', 'report.md',
  ]);
  assert.match(result.text, /Сохранение не работает/u);
  for (const visualPath of result.visualPaths) {
    assert.ok(visualPath.startsWith(own.cacheDir));
    await access(visualPath);
  }
});

test('unsupported и skipped остаются incomplete, не кэшируются и не раскрывают skip payload', async (t) => {
  const attachments = [
    attachment(1, { kind: 'animation', name: 'demo.mp4' }),
    attachment(2, { kind: 'document', name: 'report.pdf' }),
    attachment(3, { kind: 'sticker', name: 'animated.tgs' }),
    attachment(4, { kind: 'document', name: 'broken.txt' }),
    attachment(5, { kind: 'voice', name: 'missing.ogg' }),
  ];
  const own = await fixture(t);
  const result = await own.analyzer.analyze({
    item: item(attachments),
    materialize: async () => ({
      files: [
        { index: 0, buffer: Buffer.from('animation'), ...attachments[0] },
        { index: 1, buffer: Buffer.from('pdf'), ...attachments[1] },
        { index: 2, buffer: Buffer.from('sticker'), ...attachments[2] },
        { index: 3, buffer: Buffer.from([0xff, 0xfe]), ...attachments[3] },
      ],
      skipped: [{
        index: 4,
        attachment: { ref: 'opaque-skipped-ref', dedupeKey: 'opaque-skipped-dedupe' },
        reason: 'token=opaque-provider-token',
      }],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.entries.map((entryValue) => entryValue.status), [
    'unsupported', 'unsupported', 'unsupported', 'unsupported', 'skipped',
  ]);
  const serialized = JSON.stringify(result);
  for (const secret of ['opaque-skipped-ref', 'opaque-skipped-dedupe', 'opaque-provider-token']) {
    assert.ok(!serialized.includes(secret), secret);
  }
  const names = await cacheFiles(own.cacheDir, result.key);
  assert.equal(names.some((name) => name.endsWith('.json')), false);
  await assertTempClean(own.cacheDir);
});

test('server-only index сохраняет позицию skipped A и ready B', async (t) => {
  const attachments = [
    attachment(1, { kind: 'voice', name: 'missing.ogg' }),
    attachment(2, { kind: 'audio', displayLabel: 'аудио', name: 'ready.mp3' }),
  ];
  const own = await fixture(t, {
    transcribe: async () => ({ text: 'содержимое второго файла' }),
  });
  const result = await own.analyzer.analyze({
    item: item(attachments),
    materialize: async () => ({
      files: [{ index: 1, buffer: Buffer.from('audio'), ...attachments[1] }],
      skipped: [{
        index: 0,
        attachment: {
          ref: attachments[0].ref,
          dedupeKey: attachments[0].dedupeKey,
        },
        reason: 'opaque-provider-error',
      }],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.entries.map((entryValue) => ({
    index: entryValue.index,
    kind: entryValue.kind,
    status: entryValue.status,
    name: entryValue.name,
  })), [
    { index: 0, kind: 'voice', status: 'skipped', name: 'missing.ogg' },
    { index: 1, kind: 'audio', status: 'ready', name: 'ready.mp3' },
  ]);
  assert.match(result.text, /содержимое второго файла/u);
  assert.ok(!JSON.stringify(result).includes('opaque-provider-error'));

  const invalid = await own.analyzer.analyze({
    item: item(attachments, { ref: 'typed-item-invalid-position' }),
    materialize: async () => ({
      files: [{ index: 0, buffer: Buffer.from('audio'), ...attachments[1] }],
      skipped: [{ index: 0 }],
    }),
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.entries[0].reason, /позиционный контракт/u);
});

test('операционная ошибка очищает tmp и возвращается без provider error text', async (t) => {
  const source = attachment(1, { ref: 'opaque-error-ref' });
  const own = await fixture(t, {
    async transcribe() {
      throw new Error('provider failed for opaque-error-ref token-secret');
    },
  });
  const result = await own.analyzer.analyze({
    item: item([source]),
    materialize: async () => ({
      files: [{ index: 0, buffer: Buffer.from('voice'), ...source }],
      skipped: [],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.entries[0].status, 'error');
  assert.ok(!JSON.stringify(result).includes('opaque-error-ref'));
  assert.ok(!JSON.stringify(result).includes('token-secret'));
  const names = await cacheFiles(own.cacheDir, result.key);
  assert.equal(names.some((name) => name.endsWith('.json')), false);
  await assertTempClean(own.cacheDir);
});

test('AbortSignal прерывает распознавание, очищает tmp и не заполняет кэш', async (t) => {
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const source = attachment(1);
  const own = await fixture(t, {
    transcribe: ({ signal }) => new Promise((resolve, reject) => {
      markStarted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const analysis = own.analyzer.analyze({
    item: item([source]),
    signal: controller.signal,
    materialize: async () => ({
      files: [{ index: 0, buffer: Buffer.from('voice'), ...source }],
      skipped: [],
    }),
  });
  await started;
  const [key] = own.analyzer.inFlight.keys();
  const operation = own.analyzer.inFlight.get(key).promise;
  assert.match(key, /^[a-f0-9]{64}$/u);
  controller.abort();
  await assert.rejects(analysis, (error) => error?.name === 'AbortError');
  await assert.rejects(operation, (error) => error?.name === 'AbortError');
  await Promise.resolve();
  assert.equal(own.analyzer.inFlight.size, 0);
  assert.equal((await cacheFiles(own.cacheDir, key)).some((name) => name.endsWith('.json')), false);
  await assertTempClean(own.cacheDir);
});

test('abort одного in-flight consumer не отменяет общий анализ для второго', async (t) => {
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  let materializeCalls = 0;
  let internalSignal;
  let resolveTranscript;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const source = attachment(1);
  const own = await fixture(t, {
    transcribe: ({ signal }) => new Promise((resolve) => {
      internalSignal = signal;
      resolveTranscript = resolve;
      markStarted();
    }),
  });
  const materialize = async () => {
    materializeCalls += 1;
    return {
      files: [{ index: 0, buffer: Buffer.from('voice'), ...source }],
      skipped: [],
    };
  };
  const first = own.analyzer.analyze({
    item: item([source]), materialize, signal: firstAbort.signal,
  });
  const second = own.analyzer.analyze({
    item: item([source]), materialize, signal: secondAbort.signal,
  });
  await started;
  firstAbort.abort();
  await assert.rejects(first, (error) => error?.name === 'AbortError');
  assert.equal(internalSignal.aborted, false);
  resolveTranscript({ text: 'общий результат' });
  const result = await second;
  assert.equal(result.complete, true);
  assert.match(result.text, /общий результат/u);
  assert.equal(materializeCalls, 1);
});

test('retry не присоединяется к отменённой операции в очереди', async (t) => {
  let calls = 0;
  let releaseFirst;
  let markStarted;
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });
  const own = await fixture(t, {
    transcribe: () => {
      calls += 1;
      if (calls === 1) {
        markStarted();
        return new Promise((resolve) => { releaseFirst = resolve; });
      }
      return { text: 'повтор выполнен' };
    },
  });
  const firstAttachment = attachment(1);
  const secondAttachment = attachment(2);
  const first = own.analyzer.analyze({
    item: item([firstAttachment]),
    materialize: async () => ({
      files: [{ index: 0, buffer: Buffer.from('first'), ...firstAttachment }],
      skipped: [],
    }),
  });
  await firstStarted;

  const abort = new AbortController();
  const secondItem = item([secondAttachment], { ref: 'typed-item-queued-retry' });
  const materializeSecond = async () => ({
    files: [{ index: 0, buffer: Buffer.from('second'), ...secondAttachment }],
    skipped: [],
  });
  const cancelled = own.analyzer.analyze({
    item: secondItem,
    materialize: materializeSecond,
    signal: abort.signal,
  });
  abort.abort();
  await assert.rejects(cancelled, (error) => error?.name === 'AbortError');
  const retry = own.analyzer.analyze({ item: secondItem, materialize: materializeSecond });

  releaseFirst({ text: 'первый выполнен' });
  await first;
  const result = await retry;
  assert.equal(result.complete, true);
  assert.match(result.text, /повтор выполнен/u);
  assert.equal(calls, 2);
});

test('dynamic revision инвалидирует cold cache при смене speech settings', async (t) => {
  let revision = 'model=small;language=ru';
  let transcribeCalls = 0;
  let materializeCalls = 0;
  const source = attachment(1);
  const own = await fixture(t, {
    revision: () => revision,
    async transcribe() {
      transcribeCalls += 1;
      return { text: `транскрипт ${transcribeCalls}` };
    },
  });
  const materialize = async () => {
    materializeCalls += 1;
    return {
      files: [{ index: 0, buffer: Buffer.from('voice'), ...source }],
      skipped: [],
    };
  };
  const first = await own.analyzer.analyze({ item: item([source]), materialize });
  revision = 'model=medium;language=ru';
  const second = await own.analyzer.analyze({ item: item([source]), materialize });
  assert.notEqual(first.key, second.key);
  assert.match(first.text, /транскрипт 1/u);
  assert.match(second.text, /транскрипт 2/u);
  assert.equal(transcribeCalls, 2);
  assert.equal(materializeCalls, 2);
});

test('разные keys получают изолированные visual directories, spoofed raster отклоняется', async (t) => {
  const firstAttachment = attachment(1, { kind: 'image', name: 'first.png' });
  const secondAttachment = attachment(2, { kind: 'image', name: 'second.png' });
  const own = await fixture(t);
  const first = await own.analyzer.analyze({
    item: item([firstAttachment]),
    materialize: async () => ({
      files: [{ index: 0, buffer: PNG, ...firstAttachment }],
      skipped: [],
    }),
  });
  const second = await own.analyzer.analyze({
    item: item([secondAttachment], {
      ref: 'typed-item-other',
      revision: `v1_${'c'.repeat(43)}`,
    }),
    materialize: async () => ({
      files: [{ index: 0, buffer: PNG, ...secondAttachment }],
      skipped: [],
    }),
  });
  assert.equal(first.complete, true);
  assert.equal(second.complete, true);
  assert.notEqual(path.dirname(first.visualPaths[0]), path.dirname(second.visualPaths[0]));
  assert.ok(path.dirname(first.visualPaths[0]).includes(first.key));
  assert.ok(path.dirname(second.visualPaths[0]).includes(second.key));

  const spoof = attachment(3, { kind: 'image', name: 'payload.jpg' });
  const rejected = await own.analyzer.analyze({
    item: item([spoof], {
      ref: 'typed-item-spoof',
      revision: `v1_${'d'.repeat(43)}`,
    }),
    materialize: async () => ({
      files: [{ index: 0, buffer: Buffer.from('not an image'), ...spoof }],
      skipped: [],
    }),
  });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.complete, false);
  assert.equal(rejected.entries[0].status, 'unsupported');
  assert.deepEqual(rejected.visualPaths, []);

  const truncated = Buffer.alloc(24);
  PNG.subarray(0, 24).copy(truncated);
  const malformed = attachment(4, { kind: 'image', name: 'truncated.png' });
  const malformedResult = await own.analyzer.analyze({
    item: item([malformed], {
      ref: 'typed-item-malformed',
      revision: `v1_${'e'.repeat(43)}`,
    }),
    materialize: async () => ({
      files: [{ index: 0, buffer: truncated, ...malformed }],
      skipped: [],
    }),
  });
  assert.equal(malformedResult.complete, false);
  assert.equal(malformedResult.entries[0].status, 'unsupported');
});

test('aggregate pixel budget ограничивает пакет изображений', async (t) => {
  const firstAttachment = attachment(1, { kind: 'image', name: 'large-a.png' });
  const secondAttachment = attachment(2, { kind: 'image', name: 'large-b.png' });
  const large = Buffer.from(PNG);
  large.writeUInt32BE(5_000, 16);
  large.writeUInt32BE(5_000, 20);
  const own = await fixture(t);
  const result = await own.analyzer.analyze({
    item: item([firstAttachment, secondAttachment]),
    materialize: async () => ({
      files: [
        { index: 0, buffer: large, ...firstAttachment },
        { index: 1, buffer: large, ...secondAttachment },
      ],
      skipped: [],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.match(result.entries[0].reason, /Суммарное разрешение/u);
});

test('разные fingerprints обрабатываются последовательно', async (t) => {
  let active = 0;
  let maximum = 0;
  let starts = 0;
  const releases = [];
  let markFirst;
  let markSecond;
  const firstStarted = new Promise((resolve) => { markFirst = resolve; });
  const secondStarted = new Promise((resolve) => { markSecond = resolve; });
  const own = await fixture(t, {
    transcribe: () => new Promise((resolve) => {
      starts += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      releases.push(() => {
        active -= 1;
        resolve({ text: `результат ${starts}` });
      });
      if (starts === 1) markFirst();
      else markSecond();
    }),
  });
  const firstAttachment = attachment(1);
  const secondAttachment = attachment(2);
  const first = own.analyzer.analyze({
    item: item([firstAttachment]),
    materialize: async () => ({
      files: [{ index: 0, buffer: Buffer.from('one'), ...firstAttachment }], skipped: [],
    }),
  });
  const second = own.analyzer.analyze({
    item: item([secondAttachment], { ref: 'typed-item-second' }),
    materialize: async () => ({
      files: [{ index: 0, buffer: Buffer.from('two'), ...secondAttachment }], skipped: [],
    }),
  });
  await firstStarted;
  assert.equal(starts, 1);
  releases.shift()();
  await first;
  await secondStarted;
  assert.equal(starts, 2);
  assert.equal(maximum, 1);
  releases.shift()();
  assert.equal((await second).complete, true);
});

test('TTL удаляет старую cache-запись вместе с её visual artifacts', async (t) => {
  let clock = Date.now();
  const own = await fixture(t, {
    cacheTtlMs: 1_000,
    gcIntervalMs: 1_000,
    now: () => clock,
  });
  const image = attachment(1, { kind: 'image', name: 'old.png' });
  const first = await own.analyzer.analyze({
    item: item([image]),
    materialize: async () => ({
      files: [{ index: 0, buffer: PNG, ...image }],
      skipped: [],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const record = path.join(own.cacheDir, first.key.slice(0, 2), `${first.key}.json`);
  const visualRoot = path.join(own.cacheDir, first.key.slice(0, 2), first.key);
  const old = new Date(clock - 2_000);
  await utimes(record, old, old);
  await first.release();
  clock += 2_000;

  await own.analyzer.analyze({
    item: item([], { ref: 'typed-item-trigger-gc' }),
    materialize: async () => ({ files: [], skipped: [] }),
  });

  await assert.rejects(access(record), (error) => error?.code === 'ENOENT');
  await assert.rejects(access(visualRoot), (error) => error?.code === 'ENOENT');
});

test('полный GC на cache hit запускается не чаще заданного интервала', async (t) => {
  let clock = Date.now();
  const own = await fixture(t, {
    gcIntervalMs: 1_000,
    now: () => clock,
  });
  const cachedItem = item([], { ref: 'typed-item-throttled-gc' });
  await own.analyzer.analyze({
    item: cachedItem,
    materialize: async () => ({ files: [], skipped: [] }),
  });
  let scans = 0;
  const scanBucket = own.analyzer._scanBucket.bind(own.analyzer);
  own.analyzer._scanBucket = async (...args) => {
    scans += 1;
    return scanBucket(...args);
  };

  await own.analyzer.analyze({
    item: cachedItem,
    materialize: async () => assert.fail('cache hit не должен materialize вложения'),
  });
  assert.equal(scans, 0);

  clock += 1_000;
  await own.analyzer.analyze({
    item: cachedItem,
    materialize: async () => assert.fail('периодический GC не инвалидирует свежий кэш'),
  });
  assert.equal(scans, 1);
});

test('quota не удаляет queued/current key и освобождается после его завершения', async (t) => {
  const seeded = await fixture(t);
  const queuedItem = item([], { ref: 'typed-item-queued-cache' });
  const queuedSeed = await seeded.analyzer.analyze({
    item: queuedItem,
    materialize: async () => ({ files: [], skipped: [] }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const queuedRecord = path.join(
    seeded.cacheDir,
    queuedSeed.key.slice(0, 2),
    `${queuedSeed.key}.json`,
  );

  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const analyzer = new InboxAttachmentAnalyzer({
    cacheDir: seeded.cacheDir,
    cacheMaxBytes: 1,
    transcribe: () => new Promise((resolve) => {
      release = () => resolve({ text: 'готово' });
      markStarted();
    }),
  });
  const voice = attachment(9);
  const running = analyzer.analyze({
    item: item([voice], { ref: 'typed-item-running-gc' }),
    materialize: async () => ({
      files: [{ index: 0, buffer: Buffer.from('voice'), ...voice }],
      skipped: [],
    }),
  });
  let cachedMaterializeCalls = 0;
  const queued = analyzer.analyze({
    item: queuedItem,
    materialize: async () => {
      cachedMaterializeCalls += 1;
      return { files: [], skipped: [] };
    },
  });

  await started;
  await access(queuedRecord);
  release();
  const runningResult = await running;
  assert.equal(runningResult.complete, true);
  const result = await queued;
  assert.equal(result.key, queuedSeed.key);
  assert.equal(cachedMaterializeCalls, 0);
  await access(queuedRecord);
  const runningRecord = path.join(
    seeded.cacheDir,
    runningResult.key.slice(0, 2),
    `${runningResult.key}.json`,
  );
  await assert.rejects(access(runningRecord), (error) => error?.code === 'ENOENT');
});

test('downstream lease удерживает visualPaths до явного release', async (t) => {
  const own = await fixture(t, { cacheMaxBytes: 1 });
  const image = attachment(1, { kind: 'image', name: 'leased.png' });
  const leased = await own.analyzer.analyze({
    item: item([image], { ref: 'typed-item-leased-visual' }),
    materialize: async () => ({
      files: [{ index: 0, buffer: PNG, ...image }],
      skipped: [],
    }),
  });
  assert.equal(typeof leased.release, 'function');
  assert.equal(Object.keys(leased).includes('release'), false);
  assert.equal(JSON.stringify(leased).includes('release'), false);
  const leasedPath = leased.visualPaths[0];
  const leasedRecord = path.join(
    own.cacheDir,
    leased.key.slice(0, 2),
    `${leased.key}.json`,
  );
  const old = new Date(Date.now() - 2_000);
  await utimes(leasedRecord, old, old);

  await own.analyzer.analyze({
    item: item([], { ref: 'typed-item-quota-competitor' }),
    materialize: async () => ({ files: [], skipped: [] }),
  });
  await access(leasedPath);
  await access(leasedRecord);

  const firstRelease = leased.release();
  const secondRelease = leased.release();
  assert.equal(firstRelease, secondRelease);
  await firstRelease;
  await assert.rejects(access(leasedPath), (error) => error?.code === 'ENOENT');
  await assert.rejects(access(leasedRecord), (error) => error?.code === 'ENOENT');
});

test('GC чистит старые tmp и симлинки, не выходит за cacheDir', async (t) => {
  const clock = Date.now() + 5_000;
  const own = await fixture(t, {
    tmpTtlMs: 1_000,
    now: () => clock,
  });
  await mkdir(own.cacheDir, { recursive: true });
  const outside = path.join(own.root, 'outside');
  const sentinel = path.join(outside, 'keep.txt');
  await mkdir(outside);
  await writeFile(sentinel, 'не удалять');

  const tempRoot = path.join(own.cacheDir, '.tmp');
  const oldWork = path.join(tempRoot, 'dead-work');
  await mkdir(oldWork, { recursive: true });
  await writeFile(path.join(oldWork, 'input.bin'), 'old');
  const old = new Date(clock - 2_000);
  await utimes(oldWork, old, old);
  const tempLink = path.join(tempRoot, 'dead-link');
  await symlink(outside, tempLink, 'dir');

  const bucketLink = path.join(own.cacheDir, 'aa');
  await symlink(outside, bucketLink, 'dir');
  const unsafeKey = 'a'.repeat(64);
  const outsideNested = path.join(outside, unsafeKey);
  const nestedSentinel = path.join(outsideNested, 'keep-nested.txt');
  await mkdir(outsideNested);
  await writeFile(nestedSentinel, 'не удалять через bucket symlink');
  assert.equal(
    await own.analyzer._removeCachePath(path.join(bucketLink, unsafeKey)),
    false,
  );
  assert.equal((await lstat(nestedSentinel)).isFile(), true);
  const fakeKey = 'b'.repeat(64);
  const fakeBucket = path.join(own.cacheDir, fakeKey.slice(0, 2));
  const visualLink = path.join(fakeBucket, fakeKey);
  await mkdir(fakeBucket);
  await symlink(outside, visualLink, 'dir');

  await own.analyzer._garbageCollect();

  for (const removed of [oldWork, tempLink, bucketLink, visualLink]) {
    await assert.rejects(access(removed), (error) => error?.code === 'ENOENT');
  }
  assert.equal((await lstat(sentinel)).isFile(), true);
  assert.equal((await lstat(nestedSentinel)).isFile(), true);
  await assert.rejects(
    own.analyzer._removeCachePath(outside),
    (error) => error instanceof TypeError && /за пределы/u.test(error.message),
  );

  const linkedCache = path.join(own.root, 'linked-cache');
  await symlink(outside, linkedCache, 'dir');
  const unsafe = new InboxAttachmentAnalyzer({ cacheDir: linkedCache });
  await assert.rejects(unsafe.analyze({
    item: item([], { ref: 'typed-item-symlink-root' }),
    materialize: async () => ({ files: [], skipped: [] }),
  }), /симлинком/u);
  assert.equal((await lstat(sentinel)).isFile(), true);
});

test('GC остаётся последовательным после hard timeout анализа', async (t) => {
  const own = await fixture(t, { timeoutMs: 100 });
  const collectNow = own.analyzer._garbageCollectNow.bind(own.analyzer);
  let calls = 0;
  let active = 0;
  let maximum = 0;
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  own.analyzer._garbageCollectNow = async (...args) => {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      if (calls === 1) {
        markFirstStarted();
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
      return await collectNow(...args);
    } finally {
      active -= 1;
    }
  };

  const timedOut = own.analyzer.analyze({
    item: item([], { ref: 'typed-item-gc-timeout' }),
    materialize: async () => ({ files: [], skipped: [] }),
  });
  await firstStarted;
  await assert.rejects(timedOut, (error) => error?.code === 'attachment_analysis_timeout');

  const recovered = own.analyzer.analyze({
    item: item([], { ref: 'typed-item-after-gc-timeout' }),
    materialize: async () => ({ files: [], skipped: [] }),
  });
  let recoveredSettled = false;
  recovered.finally(() => { recoveredSettled = true; }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 1);
  assert.equal(recoveredSettled, false);
  releaseFirst();
  assert.equal((await recovered).complete, true);
  assert.ok(calls >= 1);
  assert.equal(maximum, 1);
});

test('hard timeout освобождает очередь даже если dependency игнорирует signal', async (t) => {
  const source = attachment(1);
  let transcribeCalls = 0;
  let releaseIgnored;
  const own = await fixture(t, {
    timeoutMs: 100,
    transcribe: () => {
      transcribeCalls += 1;
      if (transcribeCalls === 1) {
        return new Promise((resolve) => { releaseIgnored = resolve; });
      }
      return { text: 'очередь освобождена' };
    },
  });
  await assert.rejects(own.analyzer.analyze({
    item: item([source]),
    materialize: async () => ({
      files: [{ index: 0, buffer: Buffer.from('voice'), ...source }], skipped: [],
    }),
  }), (error) => error?.code === 'attachment_analysis_timeout');

  const second = attachment(2);
  const recovered = await own.analyzer.analyze({
    item: item([second], { ref: 'typed-item-after-timeout' }),
    materialize: async () => ({
      files: [{ index: 0, buffer: Buffer.from('voice-2'), ...second }], skipped: [],
    }),
  });
  assert.equal(recovered.complete, true);
  assert.match(recovered.text, /очередь освобождена/u);
  releaseIgnored({ text: 'слишком поздно' });
  await new Promise((resolve) => setImmediate(resolve));
  await assertTempClean(own.cacheDir);
});
