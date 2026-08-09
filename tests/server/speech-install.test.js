import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(root, 'bin/lib/media-runtime.sh');

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-install-'));
  mkdirSync(path.join(dir, 'server'), { recursive: true });
  copyFileSync(path.join(root, 'server/requirements-media.txt'), path.join(dir, 'server/requirements-media.txt'));
  copyFileSync(path.join(root, 'server/requirements-media-cuda.txt'), path.join(dir, 'server/requirements-media-cuda.txt'));
  const bin = path.join(dir, 'fake-bin');
  mkdirSync(bin);
  const python3 = path.join(bin, 'python3');
  writeFileSync(python3, `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == -m && "\${2:-}" == venv ]]; then
  target=\${3:?}
  mkdir -p "$target/bin"
  cp "$0" "$target/bin/python"
  chmod +x "$target/bin/python"
  exit 0
fi
printf '%s\\n' "$*" >> "\${COCKPIT_TEST_PIP_LOG:?}"
if [[ "$*" == *"pip show nvidia-cublas-cu12"* ]]; then
  [[ "\${COCKPIT_TEST_CUDA_INSTALLED:-0}" == 1 ]] && exit 0
  exit 1
fi
`, { mode: 0o755 });
  chmodSync(python3, 0o755);
  return { dir, bin, log: path.join(dir, 'pip.log') };
}

function run(fx, args = [], extraEnv = {}) {
  const script = 'source "$1"; shift; cockpit_install_media "$1" "${@:2}"';
  return execFileSync('bash', ['-c', script, 'speech-install', helper, fx.dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fx.bin}:${process.env.PATH}`,
      COCKPIT_TEST_PIP_LOG: fx.log,
      COCKPIT_MEDIA_PYTHON: '',
      COCKPIT_MEDIA_CUDA: '',
      ...extraEnv,
    },
  });
}

test('media helper creates venv and updates env once', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  run(fx, ['--no-cuda']);
  run(fx, ['--no-cuda']);

  const env = readFileSync(path.join(fx.dir, '.env'), 'utf8');
  assert.equal(env.match(/^COCKPIT_MEDIA_PYTHON=/gm)?.length, 1);
  assert.equal(env.match(/^COCKPIT_MEDIA_HF_DIR=/gm)?.length, 1);
  assert.match(env, /server\/\.state\/media-venv\/bin\/python/);
  assert.match(env, /COCKPIT_MEDIA_HF_DIR=.*server\/\.state\/hf/);
  assert.ok(existsSync(path.join(fx.dir, 'server/.state/media-venv/bin/python')));
  assert.match(readFileSync(fx.log, 'utf8'), /pip install -r .*requirements-media\.txt/);
  assert.equal(statSync(path.join(fx.dir, '.env')).mode & 0o777, 0o600);
});

test('env rewrite создаёт secret temp с 0600 до первой записи', () => {
  const source = readFileSync(helper, 'utf8');
  assert.match(source, /umask 077[\s\S]*mktemp "\$\{file\}\.speech\.XXXXXX"[\s\S]*awk/);
  assert.doesNotMatch(source, /> "\$\{file\}\.speech\.\$\$"/);
});

test('existing custom python and HF dir are preserved', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const custom = path.join(fx.dir, 'custom/python');
  mkdirSync(path.dirname(custom), { recursive: true });
  copyFileSync(path.join(fx.bin, 'python3'), custom);
  chmodSync(custom, 0o755);
  const customHf = path.join(fx.dir, 'custom/hf');
  writeFileSync(
    path.join(fx.dir, '.env'),
    `COCKPIT_MEDIA_PYTHON=${custom}\nCOCKPIT_MEDIA_HF_DIR=${customHf}\n`,
  );

  run(fx, ['--no-cuda']);
  const env = readFileSync(path.join(fx.dir, '.env'), 'utf8');
  assert.match(env, new RegExp(`^COCKPIT_MEDIA_PYTHON=${custom}$`, 'm'));
  assert.match(env, new RegExp(`^COCKPIT_MEDIA_HF_DIR=${customHf}$`, 'm'));
});

test('битый custom python не превращает родительский каталог в venv', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const missing = path.join(fx.dir, 'custom/missing/bin/python');
  writeFileSync(path.join(fx.dir, '.env'), `COCKPIT_MEDIA_PYTHON=${missing}\n`);

  assert.throws(
    () => run(fx, ['--no-cuda']),
    /Настроенный COCKPIT_MEDIA_PYTHON не исполняемый/,
  );
  assert.equal(existsSync(path.dirname(path.dirname(missing))), false);
});

test('explicit CUDA choice installs the pinned optional requirements', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  run(fx, ['--with-cuda'], { COCKPIT_MEDIA_CUDA: '0' });
  const log = readFileSync(fx.log, 'utf8');
  assert.match(log, /requirements-media\.txt/);
  assert.match(log, /requirements-media-cuda\.txt/);
});

test('env choice and installed package are non-interactive sources of truth', (t) => {
  const byEnv = fixture();
  const installed = fixture();
  t.after(() => rmSync(byEnv.dir, { recursive: true, force: true }));
  t.after(() => rmSync(installed.dir, { recursive: true, force: true }));

  run(byEnv, [], { COCKPIT_MEDIA_CUDA: '1' });
  assert.match(readFileSync(byEnv.log, 'utf8'), /requirements-media-cuda\.txt/);

  run(installed, [], { COCKPIT_TEST_CUDA_INSTALLED: '1' });
  assert.match(readFileSync(installed.log, 'utf8'), /requirements-media-cuda\.txt/);
});

test('explicit CPU choice удаляет CUDA из уже существующего venv', (t) => {
  const byFlag = fixture();
  const byEnv = fixture();
  t.after(() => rmSync(byFlag.dir, { recursive: true, force: true }));
  t.after(() => rmSync(byEnv.dir, { recursive: true, force: true }));

  run(byFlag, ['--no-cuda'], { COCKPIT_TEST_CUDA_INSTALLED: '1' });
  assert.match(readFileSync(byFlag.log, 'utf8'), /pip uninstall -y nvidia-cublas-cu12/);

  run(byEnv, [], { COCKPIT_MEDIA_CUDA: '0', COCKPIT_TEST_CUDA_INSTALLED: '1' });
  assert.match(readFileSync(byEnv.log, 'utf8'), /pip uninstall -y nvidia-cublas-cu12/);
});

test('без TTY наличие GPU не вызывает вопрос и выбирает CPU default', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const nvidiaSmi = path.join(fx.bin, 'nvidia-smi');
  writeFileSync(nvidiaSmi, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(nvidiaSmi, 0o755);

  const output = run(fx);
  assert.match(output, /CPU-состав/);
  assert.doesNotMatch(readFileSync(fx.log, 'utf8'), /requirements-media-cuda\.txt/);
});

test('install wiring and media dependencies are reproducible', () => {
  const install = readFileSync(path.join(root, 'deploy/install.sh'), 'utf8');
  assert.match(install, /bin\/lib\/media-runtime\.sh/);
  assert.match(install, /cockpit_install_media/);
  assert.match(readFileSync(path.join(root, 'server/requirements-media.txt'), 'utf8'), /ctranslate2==4\.7\.2/);
  assert.match(readFileSync(path.join(root, 'server/requirements-media.txt'), 'utf8'), /huggingface-hub==1\.18\.0/);
  assert.match(readFileSync(path.join(root, 'server/requirements-media-cuda.txt'), 'utf8'), /nvidia-cublas-cu12==12\.9\.2\.10/);
});
