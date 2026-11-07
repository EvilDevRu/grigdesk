import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { SpeechInstallationService } from '../../server/src/lib/speech/installation.ts';
import { registerSpeechInstallation } from '../../server/src/modules/settings/speechInstallation.ts';
import { SpeechRuntime } from '../../server/src/lib/speech/runtime.ts';
import { ModelJobManager } from '../../server/src/lib/speech/modelJobs.ts';
import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(root, 'deploy/lib/media-runtime.sh');

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-speech-install-'));
  mkdirSync(path.join(dir, 'server'), { recursive: true });
  copyFileSync(path.join(root, 'server/requirements-media.txt'), path.join(dir, 'server/requirements-media.txt'));
  copyFileSync(path.join(root, 'server/requirements-media-cuda.txt'), path.join(dir, 'server/requirements-media-cuda.txt'));

  const data = path.join(dir, 'data');

  mkdirSync(data);

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
printf '%s\\n' "$*" >> "\${GRIGDESK_TEST_PIP_LOG:?}"
if [[ "$*" == *"pip show nvidia-cublas-cu12"* ]]; then
  [[ "\${GRIGDESK_TEST_CUDA_INSTALLED:-0}" == 1 ]] && exit 0
  exit 1
fi
`, { mode: 0o755 });
  chmodSync(python3, 0o755);

  return { 
    dir, 
    data, 
    bin, 
    log: path.join(dir, 'pip.log') 
  };
}

function run(fx, args = [], extraEnv = {}) {
  const script = 'source "$1"; shift; grigdesk_install_media "$1" "${@:2}"';

  return execFileSync('bash', ['-c', script, 'speech-install', helper, fx.dir, ...args], {
    encoding: 'utf8',
    env: {
      HOME: fx.dir,
      GRIGDESK_HOME: fx.data,
      NODE_ENV: 'test',
      npm_config_cache: process.env.npm_config_cache,
      PATH: `${fx.bin}:${process.env.PATH}`,
      GRIGDESK_TEST_PIP_LOG: fx.log,
      GRIGDESK_MEDIA_PYTHON: '',
      GRIGDESK_MEDIA_CUDA: '',
      ...extraEnv,
    },
  });
}

test('SI-DH media helper creates venv and updates env once', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  run(fx, ['--no-cuda']);
  run(fx, ['--no-cuda']);

  assert.ok(existsSync(path.join(fx.data, '.env')));

  const env = readFileSync(path.join(fx.data, '.env'), 'utf8');
  assert.equal(env.match(/^GRIGDESK_MEDIA_PYTHON=/gm)?.length, 1);
  assert.equal(env.match(/^GRIGDESK_MEDIA_HF_DIR=/gm)?.length, 1);
  assert.match(env, /state\/media-venv\/bin\/python/);
  assert.match(env, /GRIGDESK_MEDIA_HF_DIR=.*state\/hf/);
  assert.ok(existsSync(path.join(fx.data, 'state/media-venv/bin/python')));
  assert.match(readFileSync(fx.log, 'utf8'), /pip install -r .*requirements-media\.txt/);
  assert.equal(statSync(path.join(fx.data, '.env')).mode & 0o777, 0o600);
  assert.equal(readdirSync(fx.dir).some((name) => name === '.env' || name.startsWith('.env.speech.')), false);
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
    path.join(fx.data, '.env'),
    `GRIGDESK_MEDIA_PYTHON=${custom}\nGRIGDESK_MEDIA_HF_DIR=${customHf}\n`,
  );

  run(fx, ['--no-cuda']);
  assert.ok(existsSync(path.join(fx.data, '.env')));

  const env = readFileSync(path.join(fx.data, '.env'), 'utf8');
  assert.match(env, new RegExp(`^GRIGDESK_MEDIA_PYTHON=${custom}$`, 'm'));
  assert.match(env, new RegExp(`^GRIGDESK_MEDIA_HF_DIR=${customHf}$`, 'm'));
});

test('битый custom python не превращает родительский каталог в venv', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const missing = path.join(fx.dir, 'custom/missing/bin/python');

  writeFileSync(path.join(fx.data, '.env'), `GRIGDESK_MEDIA_PYTHON=${missing}\n`);

  assert.throws(
    () => run(fx, ['--no-cuda']),
    /Настроенный GRIGDESK_MEDIA_PYTHON не исполняемый/,
  );
  assert.equal(existsSync(path.dirname(path.dirname(missing))), false);
});

test('explicit CUDA choice installs the pinned optional requirements', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  run(fx, ['--with-cuda'], { GRIGDESK_MEDIA_CUDA: '0' });
  const log = readFileSync(fx.log, 'utf8');
  assert.match(log, /requirements-media\.txt/);
  assert.match(log, /requirements-media-cuda\.txt/);
});

test('env choice and installed package are non-interactive sources of truth', (t) => {
  const byEnv = fixture();
  const installed = fixture();
  t.after(() => rmSync(byEnv.dir, { recursive: true, force: true }));
  t.after(() => rmSync(installed.dir, { recursive: true, force: true }));

  run(byEnv, [], { GRIGDESK_MEDIA_CUDA: '1' });
  assert.match(readFileSync(byEnv.log, 'utf8'), /requirements-media-cuda\.txt/);

  run(installed, [], { GRIGDESK_TEST_CUDA_INSTALLED: '1' });
  assert.match(readFileSync(installed.log, 'utf8'), /requirements-media-cuda\.txt/);
});

test('explicit CPU choice удаляет CUDA из уже существующего venv', (t) => {
  const byFlag = fixture();
  const byEnv = fixture();
  t.after(() => rmSync(byFlag.dir, { recursive: true, force: true }));
  t.after(() => rmSync(byEnv.dir, { recursive: true, force: true }));

  run(byFlag, ['--no-cuda'], { GRIGDESK_TEST_CUDA_INSTALLED: '1' });
  assert.match(readFileSync(byFlag.log, 'utf8'), /pip uninstall -y nvidia-cublas-cu12/);

  run(byEnv, [], { GRIGDESK_MEDIA_CUDA: '0', GRIGDESK_TEST_CUDA_INSTALLED: '1' });
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

  assert.match(install, /deploy\/lib\/media-runtime\.sh/);
  assert.match(install, /grigdesk_install_media/);
  assert.match(readFileSync(path.join(root, 'server/requirements-media.txt'), 'utf8'), /ctranslate2==4\.7\.2/);
  assert.match(readFileSync(path.join(root, 'server/requirements-media.txt'), 'utf8'), /huggingface-hub==1\.18\.0/);
  assert.match(readFileSync(path.join(root, 'server/requirements-media.txt'), 'utf8'), /^av==18\.1\.0$/m);
  assert.match(readFileSync(path.join(root, 'server/requirements-media-cuda.txt'), 'utf8'), /nvidia-cublas-cu12==12\.9\.2\.10/);
});

/**
 * HTTP и сервис проверяются с временным venv и управляемым runner без сети.
 * Настоящие пакеты, настройки и кэш пользователя не участвуют в тесте.
 */
function installationFixture(t, options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'speech-runtime-ui-'));
  const venv = path.join(directory, 'state', 'media-venv');
  const calls = [];
  let maintenance = false;
  let refreshed = 0;
  let blocked = false;
  let failure = false;
  let failModel = false;
  let failDecoder = false;
  let gpu = 'no_device';
  let barrier = null;

  /**
   * Поддельный процесс создаёт только проверяемые файлы временного venv.
   * Барьер и отказ воспроизводят конкуренцию без запуска pip и скачивания пакетов.
   */
  const runner = async (file, args, commandOptions) => {
    assert.equal(maintenance, true);
    calls.push({
      file,
      args,
      env: commandOptions.env,
    });

    if (barrier) {
      await barrier;
    }
    if (file === 'python3') {
      mkdirSync(path.join(venv, 'bin'), { recursive: true });
      writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = test');
      writeFileSync(path.join(venv, 'bin', 'python'), 'test');
    }

    commandOptions.onStdout('вывод установщика\n');

    return {
      code: failure
        || failModel && args.some((arg) => arg.includes('snapshot_download(repo_id='))
        || failDecoder && args.some((arg) => arg.endsWith('audio-probe.py')) ? 1 : 0,
      signal: null,
      aborted: false,
      timedOut: false,
      stdout: args.some((arg) => arg.endsWith('cuda-probe.py'))
        ? JSON.stringify({ state: gpu }) : '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      workspaceLimitExceeded: false,
    };
  };
  const config = {
    dataHome: directory,
    rootDir: root,
    pythonPath: options.pythonPath || path.join(venv, 'bin', 'python'),
    runner,
    prepareMaintenance: async () => {
      if (blocked) {
        throw new Error('занято распознаванием');
      }

      maintenance = true;

      return () => {
        maintenance = false;
      };
    },
    refresh: async () => {
      refreshed += 1;
    },
  };
  const service = new SpeechInstallationService(config);

  t.after(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directory,
    venv,
    calls,
    config,
    service,
    refreshed: () => refreshed,
    block: (value) => {
      blocked = value;
    },
    fail: (value) => {
      failure = value;
    },
    failModel: (value) => {
      failModel = value;
    },
    failDecoder: (value) => {
      failDecoder = value;
    },
    gpu: (value) => {
      gpu = value;
    },
    hold: (value) => {
      barrier = value;
    },
  };
}

/**
 * Ожидание ограничено временем и читает серверный исход, не повторяя операцию.
 * Терминальный результат освобождает lock в том же микротакте завершения задачи.
 */
async function installedOutcome(service) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await service.current();

    if (current.job?.status !== 'running') {
      await new Promise((resolve) => setTimeout(resolve, 5));

      return current;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error('Установщик не завершился');
}

test('UI установки речи: install/update/uninstall сохраняют кэш и проверяют результат', async (t) => {
  const fx = installationFixture(t);
  const cache = path.join(fx.directory, 'state', 'hf', 'model.bin');

  mkdirSync(path.dirname(cache), { recursive: true });
  writeFileSync(cache, 'сохранённая модель');
  assert.equal((await fx.service.current()).installed, false);
  await fx.service.start('install', true);

  const installed = await installedOutcome(fx.service);

  assert.equal(installed.job.status, 'succeeded');
  assert.equal(installed.installed, true);
  assert.match(installed.job.output, /вывод установщика/);
  assert.ok(fx.calls.some((call) => call.args.includes(
    path.join(root, 'server/requirements-media-cuda.txt'),
  )));
  assert.ok(fx.calls.some((call) => call.args.includes('-c')));
  await fx.service.start('update', false);
  assert.equal((await installedOutcome(fx.service)).job.status, 'succeeded');
  await fx.service.start('uninstall', false);
  assert.equal((await installedOutcome(fx.service)).job.status, 'succeeded');
  assert.equal(existsSync(fx.venv), false);
  assert.equal(readFileSync(cache, 'utf8'), 'сохранённая модель');
  assert.equal(fx.refreshed(), 3);
});

test('UI установки речи: занятость и повторный старт не создают вторую команду', async (t) => {
  const fx = installationFixture(t);
  let release;

  fx.block(true);
  await assert.rejects(fx.service.start('install', false), /занято распознаванием/);
  assert.equal(fx.calls.length, 0);
  fx.block(false);
  fx.hold(new Promise((resolve) => {
    release = resolve;
  }));
  await fx.service.start('install', false);
  await assert.rejects(fx.service.start('install', false), /Уже выполняется/);
  release();
  assert.equal((await installedOutcome(fx.service)).job.status, 'succeeded');
});

test('UI установки речи: отказ не становится успехом, повтор восстанавливает частичный venv', async (t) => {
  const fx = installationFixture(t);

  fx.fail(true);
  await fx.service.start('install', false);

  const failed = await installedOutcome(fx.service);

  assert.equal(failed.job.status, 'failed');
  assert.match(failed.job.error, /Не удалось создать окружение Python 3 с venv/);
  assert.doesNotMatch(failed.job.error, /Установите.*python3-venv/);
  fx.fail(false);
  await fx.service.start('update', false);
  assert.equal((await installedOutcome(fx.service)).job.status, 'succeeded');
});

test('UI установки речи: отсутствие ensurepip или venv объясняет системную зависимость', async (t) => {
  for (const [stream, output] of [
    ['stdout', 'The virtual environment was not created successfully because ensurepip is not\navailable.'],
    ['stderr', '/usr/bin/python3: No module named venv'],
  ]) {
    const fx = installationFixture(t);
    const runner = fx.config.runner;

    fx.config.runner = async (file, args, options) => {
      const result = await runner(file, args, options);

      options[stream === 'stdout' ? 'onStdout' : 'onStderr'](output);

      return {
        ...result,
        code: 1,
        [stream]: output,
      };
    };
    await fx.service.start('install', false);

    const failed = await installedOutcome(fx.service);

    assert.equal(failed.job.status, 'failed');
    assert.equal(failed.job.stage, 'environment');
    assert.equal(failed.job.dependency, 'python_venv');
    assert.match(failed.job.error, /Установите.*python3-venv/);
    assert.match(failed.job.error, /повторите операцию/);
    assert.ok(failed.job.output.includes(output));
    assert.equal(fx.calls.length, 1);
    fx.config.runner = runner;
    await fx.service.start('update', false);
    assert.equal((await installedOutcome(fx.service)).job.status, 'succeeded');
  }
});

test('UI установки речи: custom Python не удаляется и running после рестарта не повторяется', async (t) => {
  const custom = installationFixture(t, { pythonPath: '/external/venv/bin/python' });

  assert.equal((await custom.service.current()).managed, false);
  await assert.rejects(custom.service.start('install', false), /Внешнее окружение/);

  const fx = installationFixture(t);
  const state = path.join(fx.directory, 'state', 'speech-install', 'current.json');

  mkdirSync(path.dirname(state), { recursive: true });
  writeFileSync(state, JSON.stringify({
    managed: true,
    installed: false,
    worker: null,
    job: {
      id: 'previous-job',
      operation: 'install',
      status: 'running',
      stage: 'packages',
      output: 'прошлый вывод',
      error: '',
    },
  }));

  const current = await fx.service.current();

  assert.equal(current.job.status, 'interrupted');
  assert.equal(current.job.output, 'прошлый вывод');
  assert.equal(fx.calls.length, 0);
});

test('UI установки речи: ссылка вместо venv не позволяет удалить внешние файлы', async (t) => {
  const fx = installationFixture(t);
  const external = path.join(fx.directory, 'external');

  mkdirSync(external);
  mkdirSync(path.dirname(fx.venv), { recursive: true });
  writeFileSync(path.join(external, 'keep'), 'чужие файлы');
  symlinkSync(external, fx.venv);
  assert.equal((await fx.service.current()).managed, false);
  await assert.rejects(fx.service.start('uninstall', false), /Внешнее окружение/);
  assert.equal(readFileSync(path.join(external, 'keep'), 'utf8'), 'чужие файлы');
});

test('UI установки речи: python3 внутри штатного venv остаётся управляемым', async (t) => {
  const fx = installationFixture(t);

  await fx.service.start('install', false);
  await installedOutcome(fx.service);
  symlinkSync('python', path.join(fx.venv, 'bin', 'python3'));
  fx.config.pythonPath = path.join(fx.venv, 'bin', 'python3');

  assert.equal((await fx.service.current()).managed, true);
  await fx.service.start('update', false);
  assert.equal((await installedOutcome(fx.service)).job.status, 'succeeded');
});

test('UI установки речи: общий пресет скачивается в runtime-кэш до успешного исхода', async (t) => {
  const fx = installationFixture(t);

  await fx.service.start('install', undefined, 'small');

  const result = await installedOutcome(fx.service);
  const download = fx.calls.find((call) => call.args.some((arg) =>
    arg.includes('snapshot_download(repo_id=')));
  const restored = new SpeechInstallationService(fx.config);

  t.after(() => restored.close());
  assert.equal(result.job.status, 'succeeded');
  assert.equal(JSON.parse(download.args[2]).modelId, 'small');
  assert.equal(download.env.HF_HOME, path.join(fx.directory, 'state', 'hf'));
  assert.match(download.args[1], /WhisperModel/);
  assert.equal(fx.calls.some((call) => call.args.some((arg) =>
    arg.endsWith('requirements-media-cuda.txt'))), false);
  assert.equal((await restored.current()).job.status, 'succeeded');
});

test('UI установки речи: ошибка скачивания не превращает готовый venv в успешную установку', async (t) => {
  const fx = installationFixture(t);

  fx.failModel(true);
  await fx.service.start('install', false);

  const result = await installedOutcome(fx.service);

  assert.equal(result.installed, true);
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.stage, 'model');
  fx.failModel(false);
  await fx.service.start('update', false);
  assert.equal((await installedOutcome(fx.service)).job.status, 'succeeded');
});

test('UI установки речи: успешный импорт не скрывает отказ файлового декодера', async (t) => {
  const fx = installationFixture(t);

  fx.failDecoder(true);
  await fx.service.start('install', false);

  const failed = await installedOutcome(fx.service);

  assert.equal(failed.job.status, 'failed');
  assert.equal(failed.job.stage, 'verification');
  assert.equal(fx.calls.some((call) => call.args.some((arg) =>
    arg.includes('snapshot_download(repo_id='))), false);
  fx.failDecoder(false);
  await fx.service.start('update', false);
  assert.equal((await installedOutcome(fx.service)).job.status, 'succeeded');
});

test('UI установки речи: Python скачивает pinned модель и проверяет веса offline', async (t) => {
  const fx = installationFixture(t);

  await fx.service.start('install', false, 'small');
  await installedOutcome(fx.service);

  const download = fx.calls.find((call) => call.args.some((arg) =>
    arg.includes('snapshot_download(repo_id=')));
  const modules = path.join(fx.directory, 'python-stubs');

  mkdirSync(modules);
  writeFileSync(path.join(modules, 'huggingface_hub.py'), `
import os
from pathlib import Path

def snapshot_download(repo_id, revision, local_files_only=False):
    assert repo_id == 'Systran/faster-whisper-small'
    assert revision == '536b0662742c02347bc0e980a01041f333bce120'
    snapshot = Path(os.environ['HF_HOME']) / 'hub' / 'models--stub' / 'snapshots' / revision
    if not local_files_only:
        snapshot.mkdir(parents=True)
        for name in ('config.json', 'model.bin', 'tokenizer.json'):
            (snapshot / name).write_text('fixture')
    return str(snapshot)
`);
  writeFileSync(path.join(modules, 'faster_whisper.py'), `
import os
from pathlib import Path

class WhisperModel:
    def __init__(self, snapshot, device, compute_type, local_files_only):
        assert device == 'cpu' and compute_type == 'int8' and local_files_only is True
        assert (Path(snapshot) / 'model.bin').read_text() == 'fixture'
        (Path(os.environ['HF_HOME']) / 'weights-loaded').write_text('ok')
`);
  execFileSync('python3', download.args, {
    env: {
      ...download.env,
      PYTHONPATH: modules,
      PYTHONDONTWRITEBYTECODE: '1',
    },
    timeout: 10_000,
  });
  assert.equal(readFileSync(path.join(download.env.HF_HOME, 'weights-loaded'), 'utf8'), 'ok');
});

test('UI установки речи: GPU определяется автоматически, ручной отказ имеет приоритет', async (t) => {
  const fx = installationFixture(t);

  fx.gpu('missing_library');
  await fx.service.start('install');
  assert.equal((await installedOutcome(fx.service)).job.status, 'succeeded');
  assert.ok(fx.calls.some((call) => call.args.some((arg) => arg.endsWith('requirements-media-cuda.txt'))));
  assert.match((await fx.service.current()).job.output, /NVIDIA GPU: missing_library/);
  fx.calls.length = 0;
  await fx.service.start('update', false);
  await installedOutcome(fx.service);
  assert.equal(fx.calls.some((call) => call.args.some((arg) =>
    arg.endsWith('requirements-media-cuda.txt'))), false);
});

test('UI установки речи: alias родителя разрешён, системный Python остаётся внешним', async (t) => {
  const fx = installationFixture(t);
  const alias = `${fx.directory}-alias`;

  symlinkSync(fx.directory, alias);
  t.after(() => rmSync(alias));
  fx.config.pythonPath = path.join(alias, 'state', 'media-venv', 'bin', 'python');
  assert.equal((await fx.service.current()).managed, true);
  await fx.service.start('install', false);
  assert.equal((await installedOutcome(fx.service)).job.status, 'succeeded');
  fx.config.pythonPath = '/usr/bin/python3';
  assert.equal((await fx.service.current()).managed, false);
});

test('UI установки речи: настоящий supervisor запускает argv и освобождает worker', async (t) => {
  const fx = installationFixture(t);
  const bin = path.join(fx.directory, 'fake-bin');

  mkdirSync(bin);

  for (const command of ['ffmpeg', 'ffprobe']) {
    writeFileSync(path.join(bin, command), '#!/bin/sh\nprintf "media fixture\\n"\n', { mode: 0o755 });
  }

  writeFileSync(path.join(bin, 'python3'), `#!/bin/sh
set -eu
if [ "$1" = -m ] && [ "$2" = venv ]; then
  mkdir -p "$3/bin"
  printf 'home = test\\n' > "$3/pyvenv.cfg"
  cp "$0" "$3/bin/python"
fi
printf 'проверка supervisor\\n'
`, { mode: 0o755 });
  fx.config.runner = undefined;
  fx.config.env = { PATH: `${bin}:${process.env.PATH}` };
  await fx.service.start('install', false);

  const result = await installedOutcome(fx.service);
  const stored = JSON.parse(readFileSync(
    path.join(fx.directory, 'state', 'speech-install', 'current.json'), 'utf8',
  ));

  assert.equal(result.job.status, 'succeeded');
  assert.match(result.job.output, /проверка supervisor/);
  assert.equal(stored.worker, null);
});

test('HTTP установки речи: строгий body, занятость и полный цикл POST → диск → GET', async (t) => {
  const fx = installationFixture(t);
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  const app = require('fastify')({ logger: false });

  registerSpeechInstallation(app, fx.service);
  t.after(() => app.close());

  assert.equal((await app.inject('/api/settings/speech/installation')).statusCode, 200);

  for (const [operation, payload] of [
    ['install', { command: 'unexpected' }],
    ['shell', {}],
    ['install', { cuda: 'unexpected' }],
    ['install', { modelId: '../../unexpected' }],
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/settings/speech/installation/${operation}`,
      payload,
    });

    assert.equal(response.statusCode, 400);
  }

  assert.equal(fx.calls.length, 0);

  mkdirSync(path.join(fx.directory, 'state', 'speech-install'), { recursive: true });

  const lock = await acquireDirectoryLock(path.join(fx.directory, 'state', 'speech-install', 'lock'));

  try {
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/settings/speech/installation/install',
      payload: {},
    });

    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.json().message, /речи обслуживается/);
  } finally {
    await lock.release();
  }

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/settings/speech/installation/install',
    payload: { modelId: 'small', cuda: false },
  });

  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json().job.status, 'running');
  await installedOutcome(fx.service);

  const current = (await app.inject('/api/settings/speech/installation')).json();
  const stored = JSON.parse(readFileSync(
    path.join(fx.directory, 'state', 'speech-install', 'current.json'), 'utf8',
  ));

  assert.equal(current.job.id, accepted.json().job.id);
  assert.equal(current.job.status, 'succeeded');
  assert.equal(stored.job.status, 'succeeded');
});

test('Runtime речи: обслуживание блокирует новые диктовки и model jobs', async (t) => {
  const fx = installationFixture(t);
  const runtime = new SpeechRuntime({ mediaDir: path.join(fx.directory, 'media') });
  const models = new ModelJobManager({
    jobsDir: path.join(fx.directory, 'model-jobs'),
    mediaHfDir: path.join(fx.directory, 'hf'),
  });

  runtime.attachModelJobs(models);
  t.after(() => runtime.shutdown());

  const release = await runtime.prepareMaintenance();

  await assert.rejects(runtime.transcribe({ filePath: '/unused.wav' }), /обслуживается/);
  await assert.rejects(runtime.startStream(), /обслуживается/);
  await assert.rejects(runtime.warmup(), /обслуживается/);
  await assert.rejects(models.startDownload('small'), /обслуживается/);
  release();

  const nextRelease = await runtime.prepareMaintenance();

  nextRelease();
});

test('Runtime речи: подготовка диктовки удерживает окружение до отмены', async (t) => {
  const fx = installationFixture(t);
  const runtime = new SpeechRuntime({ mediaDir: path.join(fx.directory, 'media') });
  const abort = new AbortController();

  t.after(() => runtime.shutdown());

  const pending = runtime.transcribe({ filePath: '/unused.wav', signal: abort.signal });

  abort.abort();
  await assert.rejects(runtime.prepareMaintenance(), /Речь сейчас используется/);
  await assert.rejects(pending, /отменено/);

  const release = await runtime.prepareMaintenance();

  release();
});

test('Runtime речи: detached видео блокирует удаление, отказ освобождает допуск', async (t) => {
  const fx = installationFixture(t);
  const jobsDir = path.join(fx.directory, 'video-jobs');
  const runtime = new SpeechRuntime({
    mediaDir: path.join(fx.directory, 'media'),
    jobsDir,
    deps: { readIngestJob: () => ({ status: 'running' }) },
  });

  mkdirSync(jobsDir);
  writeFileSync(path.join(jobsDir, 'video.json'), '{}');
  t.after(() => runtime.shutdown());
  await assert.rejects(runtime.prepareMaintenance(), /идёт расшифровка видео/);
  rmSync(path.join(jobsDir, 'video.json'));

  const release = await runtime.prepareMaintenance();

  release();
});


test('Ошибка системного ffmpeg сохраняет известное действие для терминала', async (t) => {
  const fx = installationFixture(t);
  const runner = fx.config.runner;

  fx.config.runner = async (file, args, options) => {
    const result = await runner(file, args, options);

    return file === 'ffmpeg' ? { ...result, code: 127 } : result;
  };
  await fx.service.start('install', false);

  const failed = await installedOutcome(fx.service);

  assert.equal(failed.job.status, 'failed');
  assert.equal(failed.job.dependency, 'ffmpeg');
  assert.match(failed.job.error, /ffmpeg и ffprobe/);
  assert.equal(fx.calls.some((call) => call.file === 'ffprobe'), false);
});
