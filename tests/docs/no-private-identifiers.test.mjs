import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const THIS_FILE = path.relative(ROOT, fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

// Публичное происхождение upstream допустимо только там, где оно является частью release UX.
const PUBLIC_UPSTREAM = ['Evil', 'DevRu'].join('');
const PUBLIC_UPSTREAM_FILES = new Set([
  'README.md',
  'tests/server/cockpit-release.test.js',
]);

// Эти значения выбраны как очевидно синтетические и используются общими Telegram fixtures.
// Новый id сначала добавляется сюда с объяснимым synthetic pattern, а не копируется из runtime.
const SYNTHETIC_TELEGRAM_CHAT_IDS = new Set([
  '-1001000000042',
  '-1001234567890',
  '-1009876543210',
  '-1009999999999',
]);
const SYNTHETIC_HOME_USERS = new Set(['kimi', 'private', 'test', 'u', 'user']);
const SYNTHETIC_PROFILE_DIRS = new Set(['demo', 'demo-profile', 'fixture', 'sample-profile']);
const TELEGRAM_CONTROL_PATHS = new Set(['addstickers', 'c', 'joinchat', 'share']);

function isSyntheticUuid(value) {
  const lower = value.toLowerCase();
  if (/^00000000-0000-4000-8000-0000000000[0-9a-f]{2}$/.test(lower)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-0000000000[0-9a-f]{2}$/.test(lower)) return true;
  if (/^([0-9a-f])\1{7}-\1{4}-[47]\1{3}-[89ab]\1{3}-\1{12}$/.test(lower)) return true;
  return new Set([
    '01234567-89ab-4def-8abc-0123456789ab',
    '12345678-1234-5678-9abc-123456789abc',
  ]).has(lower);
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function scanText(file, source) {
  const hits = [];
  const lower = source.toLocaleLowerCase('ru-RU');

  const upstreamIndex = lower.indexOf(PUBLIC_UPSTREAM.toLowerCase());
  if (upstreamIndex !== -1 && !PUBLIC_UPSTREAM_FILES.has(file)) {
    hits.push(`${file}:${lineAt(source, upstreamIndex)}: upstream identity outside provenance allowlist`);
  }

  for (const match of source.matchAll(/-100\d{10}\b/g)) {
    if (!SYNTHETIC_TELEGRAM_CHAT_IDS.has(match[0])) {
      hits.push(`${file}:${lineAt(source, match.index)}: non-synthetic Telegram chat id`);
    }
  }

  for (const match of source.matchAll(/\/home\/([A-Za-z0-9._-]+)(?=\/|\b)/g)) {
    if (!SYNTHETIC_HOME_USERS.has(match[1])) {
      hits.push(`${file}:${lineAt(source, match.index)}: non-synthetic home path`);
    }
  }

  for (const match of source.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu)) {
    if (!isSyntheticUuid(match[0])) {
      hits.push(`${file}:${lineAt(source, match.index)}: UUID fixture is not visibly synthetic`);
    }
  }

  for (const match of source.matchAll(/(?:^|[^A-Za-z0-9_$<])profiles\/([a-z][a-z0-9._-]*)/giu)) {
    if (!SYNTHETIC_PROFILE_DIRS.has(match[1].toLowerCase())) {
      hits.push(`${file}:${lineAt(source, match.index)}: concrete profile directory in shared repository`);
    }
  }

  if (file.startsWith('tests/')) {
    for (const match of source.matchAll(/https?:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{2,})/g)) {
      const name = match[1].toLowerCase();
      if (!name.startsWith('example_') && !TELEGRAM_CONTROL_PATHS.has(name)) {
        hits.push(`${file}:${lineAt(source, match.index)}: Telegram URL fixture is not visibly synthetic`);
      }
    }
  }

  return hits;
}

async function trackedTextFiles() {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout.split('\0').filter(Boolean);
}

test('detector distinguishes private values from documented synthetic fixtures', () => {
  const privateHome = '/home/operator-name/project';
  const unknownChat = '-1003141592653';

  assert.equal(scanText('server/example.js', privateHome).length, 1);
  assert.equal(scanText('server/example.js', unknownChat).length, 1);
  assert.equal(scanText('server/example.js', 'profiles/customer-project/profile.sh').length, 1);
  assert.equal(scanText('tests/example.js', 'https://t.me/customer_team/42').length, 1);
  assert.equal(scanText('tests/example.js', 'abcdef12-3456-4789-abcd-ef1234567890').length, 1);
  assert.deepEqual(scanText('tests/example.js', '/home/user/project -1001000000042'), []);
  assert.deepEqual(scanText('tests/example.js', 'profiles/fixture https://t.me/example_team/42'), []);
  assert.deepEqual(scanText('tests/example.js', '00000000-0000-4000-8000-000000000001'), []);
  assert.deepEqual(scanText('README.md', PUBLIC_UPSTREAM), []);
  assert.equal(scanText('web/example.vue', PUBLIC_UPSTREAM).length, 1);
});

test('tracked text contains no private profile, account, host or runtime identifiers', async () => {
  const hits = [];

  for (const file of await trackedTextFiles()) {
    if (file === THIS_FILE) continue;
    const absolute = path.join(ROOT, file);
    let source;
    try {
      if ((await stat(absolute)).size > 4 * 1024 * 1024) continue;
      source = await readFile(absolute, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (source.includes('\0')) continue;
    hits.push(...scanText(file, source));
  }

  assert.deepEqual(hits, []);
});
