import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(root, 'bin', 'lib', 'runtime-env.sh');
const probe = String.raw`
set -euo pipefail
source "$1"
cockpit_load_runtime_env "$2"
printf '%s\t%s\n' "$COCKPIT_EFFECTIVE_PORT" "$COCKPIT_EFFECTIVE_TLS_PORT"
`;

const pathProbe = String.raw`
set -euo pipefail
source "$1"
HOME="$2"
PATH="/usr/bin:/bin"
cockpit_add_cli_paths
cockpit_add_cli_paths
printf '%s\n' "$PATH"
`;

function ports(dir, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (extraEnv.COCKPIT_PORT === null) delete env.COCKPIT_PORT;
  if (extraEnv.COCKPIT_TLS_PORT === null) delete env.COCKPIT_TLS_PORT;
  return execFileSync('bash', ['-c', probe, 'runtime-env-test', helper, dir], {
    encoding: 'utf8',
    env,
  }).trim();
}

test('runtime env читает нестандартные порты из корневого .env без исполнения shell-кода', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cockpit-runtime-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'must-not-exist');
  writeFileSync(path.join(dir, '.env'), [
    'COCKPIT_PORT=18140',
    'COCKPIT_TLS_PORT=18143',
    `UNRELATED=$(touch ${marker})`,
  ].join('\n'));

  assert.equal(ports(dir, { COCKPIT_PORT: null, COCKPIT_TLS_PORT: null }), '18140\t18143');
  assert.equal(existsSync(marker), false);
});

test('экспортированные порты имеют приоритет над корневым .env', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cockpit-runtime-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, '.env'), 'COCKPIT_PORT=18140\nCOCKPIT_TLS_PORT=18143\n');

  assert.equal(ports(dir, {
    COCKPIT_PORT: '28140',
    COCKPIT_TLS_PORT: '28143',
  }), '28140\t28143');
});

test('штатные launcher-ы добавляют официальный каталог Kimi в PATH один раз', (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cockpit-kimi-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const value = execFileSync('bash', ['-c', pathProbe, 'runtime-env-test', helper, home], {
    encoding: 'utf8',
  }).trim();

  assert.equal(value, `${home}/.kimi-code/bin:/usr/bin:/bin`);
});
