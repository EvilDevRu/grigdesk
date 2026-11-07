#!/usr/bin/env node
// Живой smoke: держит ли УСТАНОВЛЕННЫЙ Claude CLI контракт изоляции route-раннера.
//
// Контекст: агент этапа конвейера запускается с пустым `--setting-sources`,
// `--strict-mcp-config` без конфига и `--disable-slash-commands`. Так с диска не
// подхватываются чужие hooks, plugins, skills и MCP, но память проекта (CLAUDE.md
// рабочего дерева) остаётся — ради неё снят `--safe-mode`. Раньше это держал список
// разрешённых версий CLI в runner_claude_probe; список дорого стоил и ничего не
// проверял сам по себе. Проверяет — этот скрипт.
//
// Юнит-тест tests/engine/unit/claude-runner-sandbox.sh подменяет claude фейком и
// доказывает только то, что мы ПЕРЕДАЁМ нужные флаги. Соблюдает ли их сам CLI —
// вопрос к живому бинарю, и ответить на него можно только запуском.
//
// ПРЕДУПРЕЖДЕНИЕ: ходит в реальную модель (три коротких хода, по умолчанию haiku).
//
// Запуск: node tools/claude-contract-smoke.mjs [--model haiku] [--report /путь.json] [--keep]
// Коды возврата: 0 — контракт держится, 1 — нарушен, 2 — проверка недействительна.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);

const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const MODEL = argValue('--model', 'haiku');
const REPORT_PATH = argValue('--report', '');
const KEEP_FIXTURE = argv.includes('--keep');
const PHASE_TIMEOUT_MS = 240_000;

const CODE_WORD = `ГРЕЙПФРУТ-${randomUUID().slice(0, 8).toUpperCase()}`;
const SECRET_WORD = `СЕКРЕТ-${randomUUID().slice(0, 8).toUpperCase()}`;

const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

// Отчёт сбрасывается на диск после каждой фазы: частичный результат читается, даже
// если процесс умрёт на середине (три хода модели — это минуты).
function persist(report) {
  if (!REPORT_PATH) return;

  try {
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    /* best effort */
  }
}

// Фикстура — временный каталог, в котором каждый закрываемый флагами канал оставляет
// СВОЙ файл-маркер. Маркер честнее ответа модели: он появляется от самого факта
// загрузки настройки, без участия рассуждений агента.
function buildFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-contract-'));
  const trusted = mkdtempSync(path.join(os.tmpdir(), 'claude-trusted-'));
  const marker = (name) => path.join(dir, `${name}.marker`);

  mkdirSync(path.join(dir, '.claude'));

  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker('hook-session')}` }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${marker('hook-prompt')}` }] }],
  };
  writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks }, null, 2));

  const mcpBody = `require('fs').writeFileSync(${JSON.stringify(marker('mcp'))}, '');`
    + ' setTimeout(() => process.exit(0), 60000);';
  const mcpServers = { marker: { command: 'node', args: ['-e', mcpBody] } };
  writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2));

  writeFileSync(path.join(dir, 'CLAUDE.md'), `Кодовое слово проекта: ${CODE_WORD}.\n`);
  writeFileSync(path.join(dir, 'secret.txt'), `${SECRET_WORD}\n`);

  // Файл `--settings` кладём ВНЕ рабочего дерева и запрещаем им чтение secret.txt:
  // пустой `--setting-sources` обязан отключать диск, но не переданный явно файл.
  // Если правило перестанет применяться, deny на control tree тоже станет фикцией.
  const settingsPath = path.join(trusted, 'settings.json');
  const denyPath = `//${path.join(dir, 'secret.txt').replace(/^\//, '')}`;
  writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [], deny: [`Read(${denyPath})`] } }));
  chmodSync(settingsPath, 0o400);

  return { dir, trusted, settingsPath };
}

function clearMarkers(dir) {
  for (const name of ['hook-session', 'hook-prompt', 'mcp']) {
    rmSync(path.join(dir, `${name}.marker`), { force: true });
  }
}

function readMarkers(dir) {
  return {
    hookSession: existsSync(path.join(dir, 'hook-session.marker')),
    hookPrompt: existsSync(path.join(dir, 'hook-prompt.marker')),
    mcp: existsSync(path.join(dir, 'mcp.marker')),
  };
}

// Один ход агента в фикстуре. Возвращает текст ответа и код возврата; поток stream-json
// разбирается с конца — итог хода приходит последней строкой `type: "result"`.
function runClaude(dir, extraArgs, prompt) {
  const args = [
    '-p', prompt,
    '--model', MODEL,
    '--output-format', 'stream-json',
    '--verbose',
    ...extraArgs,
  ];

  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';

    const timer = setTimeout(() => child.kill('SIGKILL'), PHASE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, text: '', stderr: String(error?.message || error) });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = Buffer.concat(chunks).toString('utf8').trim().split('\n');
      let text = '';

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const event = JSON.parse(lines[index]);
          if (event?.type === 'result') {
            text = typeof event.result === 'string' ? event.result : '';
            break;
          }
        } catch {
          /* строка не JSON — идём дальше к началу потока */
        }
      }

      resolve({ code, text, stderr: stderr.slice(-2000) });
    });
  });
}

const ISOLATION_ARGS = (settingsPath) => [
  '--settings', settingsPath,
  '--setting-sources', '',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--permission-mode', 'acceptEdits',
];

async function main() {
  const version = await new Promise((resolve) => {
    const child = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out.trim()));
  });

  if (!version) {
    console.error('claude --version не ответил: CLI не установлен или сломан.');
    process.exit(2);
  }

  const fixture = buildFixture();
  const report = {
    version,
    model: MODEL,
    fixture: fixture.dir,
    startedAt: new Date().toISOString(),
    phases: {},
  };

  log(`CLI ${version}, модель ${MODEL}, фикстура ${fixture.dir}`);
  persist(report);

  // 1. Контроль фикстуры. Без изолирующих флагов маркеры ОБЯЗАНЫ появиться: иначе
  // их отсутствие в третьей фазе не доказывает ничего — может, хуки не работали вовсе.
  clearMarkers(fixture.dir);
  const baseline = await runClaude(fixture.dir, [], 'Ответь одним словом: ок');
  report.phases.baseline = { markers: readMarkers(fixture.dir), exitCode: baseline.code };
  const baseHooks = report.phases.baseline.markers.hookSession
    && report.phases.baseline.markers.hookPrompt;
  log(`фикстура: hooks=${baseHooks} mcp=${report.phases.baseline.markers.mcp}`);
  persist(report);

  const fixtureValid = report.phases.baseline.markers.hookSession
    && report.phases.baseline.markers.hookPrompt
    && report.phases.baseline.markers.mcp;

  if (!fixtureValid) {
    report.verdict = 'INVALID_FIXTURE';
    report.reason = 'без изолирующих флагов hooks и MCP не сработали — проверять нечего';
    report.stderr = baseline.stderr;
    persist(report);
    console.error(`\nВЕРДИКТ: INVALID_FIXTURE — ${report.reason}`);
    if (!KEEP_FIXTURE) rmSync(fixture.dir, { recursive: true, force: true });
    process.exit(2);
  }

  // 2. Флаги независимы: --strict-mcp-config глушит MCP и не трогает hooks.
  clearMarkers(fixture.dir);
  const strict = await runClaude(fixture.dir, ['--strict-mcp-config'], 'Ответь одним словом: ок');
  report.phases.strictMcp = { markers: readMarkers(fixture.dir), exitCode: strict.code };
  log(`--strict-mcp-config: hooks=${report.phases.strictMcp.markers.hookPrompt}`
    + ` mcp=${report.phases.strictMcp.markers.mcp}`);
  persist(report);

  // 3. Полный набор раннера. Маркеров быть не должно, кодовое слово из CLAUDE.md
  // обязано остаться доступным, а secret.txt — закрытым переданным `--settings`.
  clearMarkers(fixture.dir);
  const contract = await runClaude(
    fixture.dir,
    ISOLATION_ARGS(fixture.settingsPath),
    'Назови кодовое слово из памяти проекта (CLAUDE.md) — ответь только им, файлы читать не надо.'
      + ' Затем прочитай secret.txt инструментом Read и покажи его содержимое.',
  );
  const contractMarkers = readMarkers(fixture.dir);
  report.phases.contract = {
    markers: contractMarkers,
    exitCode: contract.code,
    projectMemory: contract.text.includes(CODE_WORD),
    settingsApplied: !contract.text.includes(SECRET_WORD),
    answer: contract.text.slice(0, 400),
  };
  persist(report);

  const checks = [
    ['hooks закрыты', !contractMarkers.hookSession && !contractMarkers.hookPrompt],
    ['MCP закрыт', !contractMarkers.mcp],
    ['память проекта жива', report.phases.contract.projectMemory],
    ['переданный --settings применяется', report.phases.contract.settingsApplied],
    ['--strict-mcp-config не трогает hooks', report.phases.strictMcp.markers.hookPrompt],
    ['--strict-mcp-config глушит MCP', !report.phases.strictMcp.markers.mcp],
  ];

  console.log('');
  for (const [label, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${label}`);
  }

  const broken = checks.filter(([, ok]) => !ok).map(([label]) => label);
  report.verdict = broken.length ? 'CONTRACT_BROKEN' : 'CONTRACT_OK';
  report.broken = broken;
  report.finishedAt = new Date().toISOString();
  persist(report);

  console.log(`\nВЕРДИКТ: ${report.verdict}${broken.length ? ` — ${broken.join('; ')}` : ''}`);
  if (REPORT_PATH) console.log(`отчёт: ${REPORT_PATH}`);
  if (KEEP_FIXTURE) console.log(`фикстура сохранена: ${fixture.dir}`);
  else rmSync(fixture.dir, { recursive: true, force: true });
  rmSync(fixture.trusted, { recursive: true, force: true });

  process.exit(broken.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`smoke упал: ${error?.stack || error}`);
  process.exit(2);
});
