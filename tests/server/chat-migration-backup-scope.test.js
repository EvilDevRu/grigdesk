// Страховка перед перезаписью истории должна быть размером с риск.
// Полная копия всех чатов на каждое расхождение раздувала chats/.migration-backups
// на сотни мегабайт (17 снимков по 7,5 МБ за три недели), не добавляя защиты:
// нетронутые файлы и так лежат на месте целыми.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';

const registry = {
  claude: [{ id: 'claude-opus-5', aliases: ['opus'], tier: 100 }],
  codex: [{ id: 'gpt-5.6-sol', family: 'sol', tier: 100 }],
};

async function tempChats(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-backup-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'chats');
}

// Имя копии начинается с времени, поэтому часы обязаны идти: при застывших часах
// каталоги различались бы только случайным UUID и сортировались бы в случайном
// порядке — тест «вторая копия» проходил бы через раз.
let tick = 0;
function makeStore(chatsDir) {
  return new ChatHistoryStore({
    chatsDir,
    registryProvider: async () => registry,
    now: () => Date.UTC(2026, 7, 1) + (tick += 1000),
  });
}

async function writeChat(chatsDir, id, extra = {}) {
  const dir = path.join(chatsDir, '2026-08');
  await fs.mkdir(dir, { recursive: true });
  const chat = {
    id,
    title: `Чат ${id}`,
    messages: [{ role: 'user', text: 'Привет' }],
    createdAt: Date.UTC(2026, 7, 1),
    updatedAt: Date.UTC(2026, 7, 1),
    ...extra,
  };
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(chat), { mode: 0o600 });
  return chat;
}

async function backupDirs(chatsDir) {
  try { return (await fs.readdir(path.join(chatsDir, '.migration-backups'))).sort(); }
  catch { return []; }
}

async function backupFiles(chatsDir, dirName) {
  const root = path.join(chatsDir, '.migration-backups', dirName);
  const out = [];
  const walk = async (dir) => {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { await walk(full); continue; }
      out.push(path.relative(root, full));
    }
  };
  await walk(root);
  return out.sort();
}

test('в копию попадают только переписываемые чаты, а не вся история', async (t) => {
  const chatsDir = await tempChats(t);
  await writeChat(chatsDir, 'chat-a', { model: 'opus' });
  await writeChat(chatsDir, 'chat-b', { model: 'opus' });

  // Первый прогон канонизирует обе записи: дальше они уже в целевой форме.
  await makeStore(chatsDir).read();
  const first = await backupDirs(chatsDir);
  assert.equal(first.length, 1, 'первая миграция обязана сделать копию');

  // Появляется ОДИН новый legacy-чат; двум прежним переписывать нечего.
  await writeChat(chatsDir, 'chat-c', { model: 'opus' });
  await makeStore(chatsDir).read();

  const dirs = await backupDirs(chatsDir);
  assert.equal(dirs.length, 2, 'вторая миграция сделала свою копию');
  const files = await backupFiles(chatsDir, dirs[1]);

  assert.deepEqual(
    files.filter((f) => f.endsWith('.json') && f !== 'manifest.json' && f !== 'meta.json'),
    [path.join('2026-08', 'chat-c.json')],
    'скопирован обязан быть ровно переписываемый файл',
  );
});

test('копия хранит ИСХОДНЫЕ байты перезаписываемого файла', async (t) => {
  const chatsDir = await tempChats(t);
  await writeChat(chatsDir, 'chat-a', { model: 'opus' });
  const originalBytes = await fs.readFile(path.join(chatsDir, '2026-08', 'chat-a.json'), 'utf8');

  await makeStore(chatsDir).read();

  const [dir] = await backupDirs(chatsDir);
  const saved = await fs.readFile(
    path.join(chatsDir, '.migration-backups', dir, '2026-08', 'chat-a.json'),
    'utf8',
  );
  assert.equal(saved, originalBytes, 'копия обязана быть снимком ДО перезаписи');
  const live = await fs.readFile(path.join(chatsDir, '2026-08', 'chat-a.json'), 'utf8');
  assert.notEqual(live, originalBytes, 'живой файл при этом действительно мигрирован');
});

test('manifest считает реально скопированное, а не размер истории', async (t) => {
  const chatsDir = await tempChats(t);
  await writeChat(chatsDir, 'chat-a', { model: 'opus' });
  await writeChat(chatsDir, 'chat-b', { model: 'opus' });
  await makeStore(chatsDir).read();
  await writeChat(chatsDir, 'chat-c', { model: 'opus' });
  await makeStore(chatsDir).read();

  const dirs = await backupDirs(chatsDir);
  const manifest = JSON.parse(await fs.readFile(
    path.join(chatsDir, '.migration-backups', dirs[1], 'manifest.json'),
    'utf8',
  ));
  assert.equal(manifest.chats, 1);
  assert.equal(manifest.schema, 1, 'формат копии остаётся понятен restoreMigrationBackup');
});

test('откат возвращает именно перезаписанный файл и не трогает соседний', async (t) => {
  const chatsDir = await tempChats(t);
  await writeChat(chatsDir, 'chat-a', { model: 'opus' });
  const originalA = await fs.readFile(path.join(chatsDir, '2026-08', 'chat-a.json'), 'utf8');
  await makeStore(chatsDir).read();

  await writeChat(chatsDir, 'chat-c', { model: 'opus' });
  const store = makeStore(chatsDir);
  await store.read();
  const liveB = await fs.readFile(path.join(chatsDir, '2026-08', 'chat-c.json'), 'utf8');

  const dirs = await backupDirs(chatsDir);
  const restored = await store.restoreMigrationBackup(
    path.join(chatsDir, '.migration-backups', dirs[0]),
  );
  assert.ok(restored.some((rel) => rel.endsWith('chat-a.json')));
  assert.equal(
    await fs.readFile(path.join(chatsDir, '2026-08', 'chat-a.json'), 'utf8'),
    originalA,
    'откат вернул исходные байты',
  );
  assert.equal(
    await fs.readFile(path.join(chatsDir, '2026-08', 'chat-c.json'), 'utf8'),
    liveB,
    'соседний файл, которого в этой копии нет, остался нетронутым',
  );
});

test('изменение одной только меты не копирует ни одного чата', async (t) => {
  const chatsDir = await tempChats(t);
  await writeChat(chatsDir, 'chat-a', { model: 'opus' });
  await makeStore(chatsDir).read();

  // Мета в нелегальной для реестра форме: миграция перепишет её и только её.
  await fs.writeFile(
    path.join(chatsDir, 'meta.json'),
    JSON.stringify({ schema: 2, defModel: 'opus' }),
    { mode: 0o600 },
  );
  await makeStore(chatsDir).read();

  const dirs = await backupDirs(chatsDir);
  assert.equal(dirs.length, 2);
  const files = await backupFiles(chatsDir, dirs[1]);
  assert.deepEqual(files.sort(), ['manifest.json', 'meta.json']);
});
