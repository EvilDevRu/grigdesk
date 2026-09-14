// Резидентный процесс голосового движка: запрос строкой — ответ строкой с тем же
// id, шум библиотек в stdout пропускается, смерть процесса и срок называются
// причиной, а закрытие сеанса завершает процесс штатно.
//
// Движок подменён скриптом python3 с известным поведением: отвечает на запросы,
// умеет заснуть, умереть и выйти по концу stdin — ровно то, что должен переживать
// адаптер.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startResident } from '../../server/src/lib/showcase/voice/resident.ts';

async function fakeEngine(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-resident-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const file = path.join(root, 'engine.py');

  await writeFile(
    file,
    `#!/usr/bin/env python3
import json, sys, time
print('Warning: flash-attn is not installed', flush=True)
print('', flush=True)
for line in sys.stdin:
    if not line.strip():
        continue
    request = json.loads(line)
    if request.get('sleep'):
        time.sleep(request['sleep'])
    if request.get('die'):
        sys.stderr.write('CUDA error: device-side assert\\n')
        sys.exit(7)
    if request.get('flood'):
        print('x' * request['flood'], flush=True)
    print('not json at all', flush=True)
    results = [item.upper() for item in request['items']]
    print(json.dumps({'id': request['id'], 'results': results}), flush=True)
`,
    'utf8',
  );
  await chmod(file, 0o755);

  return file;
}

test('ответы приходят по id и по порядку, а шум в stdout не считается ответом', async (t) => {
  const engine = await fakeEngine(t);
  const process = startResident('python3', [engine]);

  t.after(() => process.close());

  const first = await process.request({ items: ['a', 'b'] }, { timeoutMs: 5000 });
  const second = await process.request({ items: ['c'] }, { timeoutMs: 5000 });

  assert.deepEqual(first, { id: '1', results: ['A', 'B'] });
  assert.deepEqual(second, { id: '2', results: ['C'] });
});

test('смерть процесса посреди запроса — код и хвост stderr, следующий запрос отказывает сразу', async (t) => {
  const engine = await fakeEngine(t);
  const process = startResident('python3', [engine]);

  t.after(() => process.close());

  await assert.rejects(
    () => process.request({ items: ['a'], die: true }, { timeoutMs: 5000 }),
    (error) => error.code === 'voice_failed'
      && error.exitCode === 7
      && /кодом 7/.test(error.message)
      && /device-side assert/.test(error.message),
  );
  await assert.rejects(
    () => process.request({ items: ['b'] }, { timeoutMs: 5000 }),
    (error) => error.exitCode === 7,
    'мёртвый процесс не принимает запросов и не зависает',
  );
  await process.close();
});

test('срок ответа снимает процесс, а отмена называется отменой', async (t) => {
  const engine = await fakeEngine(t);
  const slow = startResident('python3', [engine]);

  t.after(() => slow.close());

  await assert.rejects(
    () => slow.request({ items: ['a'], sleep: 5 }, { timeoutMs: 300 }),
    (error) => error.code === 'voice_failed' && error.status === 504 && /не ответил/.test(error.message),
  );
  await assert.rejects(
    () => slow.request({ items: ['b'] }, { timeoutMs: 1000 }),
    (error) => error.code === 'voice_failed',
    'после срока процесс снят',
  );

  const controller = new AbortController();
  const cancelled = startResident('python3', [engine]);

  t.after(() => cancelled.close());
  const pending = cancelled.request(
    { items: ['a'], sleep: 5 },
    { timeoutMs: 5000, signal: controller.signal },
  );

  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, (error) => /отменён/.test(error.message));
  await cancelled.close();
});

test('заранее отменённый запрос не зависает и снимает процесс', async (t) => {
  const engine = await fakeEngine(t);
  const process = startResident('python3', [engine]);
  const controller = new AbortController();

  t.after(() => process.close());
  controller.abort();

  const started = Date.now();

  await assert.rejects(
    () => process.request(
      { items: ['a'], sleep: 30 },
      { timeoutMs: 5000, signal: controller.signal },
    ),
    (error) => /отменён/.test(error.message),
  );
  assert.ok(Date.now() - started < 1000, 'отмена замечена до запуска долгой работы');
});

test('неограниченная строка stdout снимает процесс вместо роста памяти', async (t) => {
  const engine = await fakeEngine(t);
  const process = startResident('python3', [engine]);

  t.after(() => process.close());

  await assert.rejects(
    () => process.request(
      { items: ['a'], flood: 1024 * 1024 + 1 },
      { timeoutMs: 5000 },
    ),
    (error) => error.code === 'voice_failed' && /слишком длинную строку/.test(error.message),
  );
});

test('закрытие завершает процесс по концу stdin и повторно ничего не делает', async (t) => {
  const engine = await fakeEngine(t);
  const process = startResident('python3', [engine]);

  t.after(() => process.close());

  await process.request({ items: ['a'] }, { timeoutMs: 5000 });

  const started = Date.now();

  await process.close();
  await process.close();

  assert.ok(Date.now() - started < 4000, 'процесс вышел сам, а не по снятию через срок');
  await assert.rejects(
    () => process.request({ items: ['b'] }, { timeoutMs: 1000 }),
    (error) => error.code === 'voice_failed',
    'закрытый сеанс запросов не принимает',
  );
});
