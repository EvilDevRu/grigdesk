import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(root, 'bin', 'lib', 'install-choices.sh');

// Задаёт оба вопроса и печатает решения одной строкой.
// Строки одинарные: в шаблоне JS подставил бы shell-раскрытие ${…} как своё выражение.
const PROBE = [
  'set -euo pipefail',
  'source "$1"',
  'shift',
  'cockpit_install_parse_args "$@"',
  'cockpit_install_choice INSTALL_AUTOSTART "Автозапуск?" 1',
  'cockpit_install_choice INSTALL_SHORTCUT "Ярлык?" 0',
  'printf "autostart=%s shortcut=%s passthru=%s\\n" \\',
  '  "$INSTALL_AUTOSTART" "$INSTALL_SHORTCUT" "${INSTALL_PASSTHRU[*]-}"',
].join('\n');

const probeDir = mkdtempSync(path.join(os.tmpdir(), 'cockpit-install-choices-'));
const probeFile = path.join(probeDir, 'probe.sh');

writeFileSync(probeFile, PROBE);
process.on('exit', () => rmSync(probeDir, { recursive: true, force: true }));

const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const hasScript = spawnSync('bash', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0;

// Строка решений из вывода: под pty туда же попадают сами вопросы и возврат каретки.
function decide(result) {
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.replace(/\r/g, '').split('\n').find((row) => row.startsWith('autostart='));
  assert.ok(line, result.stdout);
  return line;
}

// Без терминала: так установщик идёт у агента, из скрипта и в CI.
function choices(args = []) {
  return decide(spawnSync('bash', [probeFile, helper, ...args], { encoding: 'utf8' }));
}

/**
 * С терминалом: `script` выделяет pty, иначе [ -t 0 ] всегда ложь и интерактивная ветка
 * молчит. Ответы подаются с паузами — набранное до самого `read` pty теряет.
 */
function interactiveChoices(args, answers) {
  const command = ['bash', probeFile, helper, ...args].map(quote).join(' ');
  const feed = answers.map((answer) => `sleep 0.25; printf '%s\\n' ${quote(answer)};`).join(' ');
  const line = `{ ${feed} sleep 0.25; } | script -q -c ${quote(command)} /dev/null`;

  return decide(spawnSync('bash', ['-c', line], { encoding: 'utf8', timeout: 30_000 }));
}

test('без терминала установщик проходит сам: автозапуск да, ярлык нет', () => {
  assert.equal(choices(), 'autostart=1 shortcut=0 passthru=');
});

test('флаги отвечают за человека, в том числе отказом от автозапуска', () => {
  assert.equal(choices(['--no-autostart', '--shortcut']), 'autostart=0 shortcut=1 passthru=');
  assert.equal(choices(['--autostart', '--no-shortcut']), 'autostart=1 shortcut=0 passthru=');
});

test('чужие аргументы установщика уходят в passthru нетронутыми', () => {
  assert.equal(choices(['--with-cuda', '--no-shortcut']), 'autostart=1 shortcut=0 passthru=--with-cuda');
});

test('в терминале: пустой ответ = подсказанное, y/n и д/н — решение человека', (t) => {
  if (!hasScript) return t.skip('нет утилиты script — pty не выделить');

  assert.equal(interactiveChoices([], ['', '']), 'autostart=1 shortcut=0 passthru=');
  assert.equal(interactiveChoices([], ['n', 'y']), 'autostart=0 shortcut=1 passthru=');
  assert.equal(interactiveChoices([], ['н', 'д']), 'autostart=0 shortcut=1 passthru=');

  return undefined;
});

test('в терминале флаг сильнее вопроса: заданное не переспрашивают', (t) => {
  if (!hasScript) return t.skip('нет утилиты script — pty не выделить');

  // Единственный вопрос — про ярлык, и первый же ответ достаётся ему.
  assert.equal(interactiveChoices(['--no-autostart'], ['y']), 'autostart=0 shortcut=1 passthru=');

  return undefined;
});
