import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import claude, {
  claudeProviderSettingsArgs,
  parseClaudeEfforts,
} from '../../server/src/lib/executors/claude.ts';
import { claudeSessionArgs } from '../../server/src/lib/executors/_claudeStream.ts';

const ORDINARY = ['low', 'medium', 'high', 'xhigh', 'max'];
const VERSION = '2.1.293 (Claude Code)\n';
const CONTROL = '__grigdesk_invalid_effort__';
const REJECTION = `Unknown --effort value: ${CONTROL}, ignoring it\n`;

/**
 * Принимает только справку и точную пробу версии, записывая весь argv и pid.
 * Каждый тест владеет своим процессом; зависание ограничивает production-таймаут пробы.
 */
async function fakeEffortCli(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-effort-probe-'));
  const bin = path.join(dir, 'claude');
  const capture = path.join(dir, 'calls.jsonl');
  const spec = {
    help: { stdout: `  --effort <level>  Effort (${ORDINARY.join(', ')})\n` },
    candidate: { stdout: VERSION },
    control: { stdout: VERSION, stderr: REJECTION },
    ...options,
  };
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const spec = ${JSON.stringify(spec)};
const capture = ${JSON.stringify(capture)};
const args = process.argv.slice(2);
fs.appendFileSync(capture, JSON.stringify({ args, pid: process.pid }) + '\\n');
let response;
if (args.length === 1 && args[0] === '--help') {
  response = spec.help;
} else if (args.length === 3 && args[0] === '--effort' && args[2] === '--version') {
  if (args[1] === 'ultracode') {
    response = spec.candidate;
  } else if (args[1] === ${JSON.stringify(CONTROL)}) {
    response = spec.control;
  }
}
if (!response) {
  process.exit(91);
}
if (response.stdout) {
  fs.writeSync(1, response.stdout);
}
if (response.stderr) {
  fs.writeSync(2, response.stderr);
}
if (response.hang) {
  setInterval(() => {}, 1000);
} else {
  process.exit(response.code || 0);
}
`;

  await writeFile(bin, script);
  await chmod(bin, 0o755);
  t.after(async () => {
    const calls = await readFile(capture, 'utf8').catch(() => '');

    for (const line of calls.trim().split('\n').filter(Boolean)) {
      const call = JSON.parse(line);
      const response = call.args[1] === 'ultracode' ? spec.candidate : spec.control;

      if (!response.hang) {
        continue;
      }

      try {
        process.kill(call.pid, 'SIGKILL');
      } catch {
        // Завершённый процесс уже убран; cleanup нужен и при отказе утверждения.
      }
    }

    await rm(dir, { recursive: true, force: true });
  });

  return {
    config: { claudeBin: bin },
    calls: async () => (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
  };
}

test('Claude effort discovery reads choices wrapped onto the next help line', () => {
  const help = [
    '  --effort <level>                      Effort level for the current session',
    '                                        (low, medium, high, xhigh, max, future)',
    '  --exclude-dynamic-system-prompt-sections',
  ].join('\n');

  assert.deepEqual(
    parseClaudeEfforts(help),
    ['low', 'medium', 'high', 'xhigh', 'max', 'future'],
  );
});

test('Claude effort discovery returns no invented levels when help has no choices', () => {
  assert.equal(parseClaudeEfforts('--effort <level>  Effort level'), null);
  assert.equal(parseClaudeEfforts([
    '  --effort <level>  Effort level',
    '  --next-option       Description with (fake, choices)',
  ].join('\n')), null);
  assert.equal(parseClaudeEfforts(''), null);
});

test('скрытый ultracode требует точной пробы кандидата и отрицательного контроля', async (t) => {
  const cli = await fakeEffortCli(t);

  assert.deepEqual(await claude.efforts(cli.config), [...ORDINARY, 'ultracode']);
  assert.deepEqual((await cli.calls()).map(({ args }) => args).sort(), [
    ['--help'],
    ['--effort', 'ultracode', '--version'],
    ['--effort', CONTROL, '--version'],
  ].sort());
});

const CANDIDATE_FAILURES = [
  ['отказ в stderr при exit 0', { stdout: VERSION, stderr: 'Unknown --effort value: ultracode' }],
  ['отказ в stdout при exit 0', { stdout: VERSION + 'Unknown --effort value: ultracode\n' }],
  ['ненулевой код с версией', { stdout: VERSION, code: 7 }],
  ['версия только в stderr', { stderr: VERSION }],
  ['пустой вывод', {}],
  ['посторонний вывод с semver', { stdout: 'Error: expected version 2.1.293 (Claude Code)\n' }],
  ['переполнение буфера', { stdout: VERSION + 'x'.repeat(256 * 1024) }],
];

for (const [name, candidate] of CANDIDATE_FAILURES) {
  test(`discovery сохраняет обычный список: ${name}`, async (t) => {
    const cli = await fakeEffortCli(t, { candidate });

    assert.deepEqual(await claude.efforts(cli.config), ORDINARY);
    assert.ok((await cli.calls()).some(({ args }) => args[1] === 'ultracode'));
  });
}

const CONTROL_FAILURES = [
  ['игнорирует любой effort', { stdout: VERSION }],
  ['отказ без версии', { stderr: REJECTION }],
  ['отказ другого имени', { stdout: VERSION, stderr: 'Unknown --effort value: other' }],
  ['контрольное имя только префикс', { stdout: VERSION, stderr: `Unknown --effort value: ${CONTROL}extra` }],
  ['ненулевой код', {
    stdout: VERSION,
    stderr: REJECTION,
    code: 1,
  }],
];

for (const [name, control] of CONTROL_FAILURES) {
  test(`отрицательная проба не подтверждена: ${name}`, async (t) => {
    const cli = await fakeEffortCli(t, { control });

    assert.deepEqual(await claude.efforts(cli.config), ORDINARY);
    assert.ok((await cli.calls()).some(({ args }) => args[1] === CONTROL));
  });
}

test('контрольный отказ в stdout также подтверждает парсинг', async (t) => {
  const cli = await fakeEffortCli(t, { control: { stdout: VERSION + REJECTION } });

  assert.deepEqual(await claude.efforts(cli.config), [...ORDINARY, 'ultracode']);
});

test('контроль узнаёт предупреждение CLI с кавычками и без двоеточия', async (t) => {
  const cli = await fakeEffortCli(t, {
    control: { stdout: VERSION, stderr: `Warning: Unknown --effort value '${CONTROL}' — ignoring it` },
  });

  assert.deepEqual(await claude.efforts(cli.config), [...ORDINARY, 'ultracode']);
});

test('таймаут кандидата сохраняет обычные ступени и завершает subprocess', async (t) => {
  const cli = await fakeEffortCli(t, { candidate: { hang: true } });

  assert.deepEqual(await claude.efforts(cli.config), ORDINARY);

  const call = (await cli.calls()).find(({ args }) => args[1] === 'ultracode');

  assert.ok(call, 'кандидат действительно запускался');
  assert.throws(() => process.kill(call.pid, 0), { code: 'ESRCH' });
});

const HELP_CASES = [
  ['отказ справки', { stdout: '--effort <level> (xhigh)', code: 1 }, null],
  ['неразобранная справка', { stdout: '--effort <level> Effort' }, null],
  ['пустая справка', {}, null],
  ['нет базы', { stdout: '--effort <level> (high, max)' }, ['high', 'max']],
  ['публичный режим в середине и дубль',
    { stdout: '--effort <level> (ultracode, low, xhigh, ultracode, max)' },
    ['low', 'xhigh', 'max', 'ultracode']],
  ['публичный режим без базы', { stdout: '--effort <level> (ultracode, high)' }, ['high']],
];

for (const [name, help, expected] of HELP_CASES) {
  test(`справка без скрытых проб: ${name}`, async (t) => {
    const cli = await fakeEffortCli(t, { help });

    assert.deepEqual(await claude.efforts(cli.config), expected);
    assert.deepEqual((await cli.calls()).map(({ args }) => args), [['--help']]);
  });
}

test('отсутствующий CLI даёт null, без выдуманного ladder', async (t) => {
  const cli = await fakeEffortCli(t);

  await rm(cli.config.claudeBin);
  assert.equal(await claude.efforts(cli.config), null);
});

test('чат передаёт ultracode как исходное значение effort', () => {
  const args = claudeSessionArgs({ effort: 'ultracode' });

  assert.equal(args[args.indexOf('--effort') + 1], 'ultracode');
});

test('смена усилия не выключает независимый ultracode в native settings', () => {
  const providerSettingsArgs = claudeProviderSettingsArgs({}, {
    directSshPolicy: false,
    nativeSettings: { payload: { ultracode: true } },
  });

  for (const effort of ['ultracode', 'high', 'max']) {
    const args = claudeSessionArgs({ effort, providerSettingsArgs });

    assert.equal(args[args.indexOf('--effort') + 1], effort);
    assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).ultracode, true);
  }
});
