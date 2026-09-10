// Отсоединённый исполнитель установки локального голоса.
//
// Делает четыре вещи по порядку: заводит отдельное python-окружение, ставит в
// него закреплённый состав, скачивает модель голоса и ПРОВЕРЯЕТ синтез. Последний
// шаг обязателен: удачный `pip install` и скачанный файл голосом ещё не являются,
// а «установлено, но молчит» человек будет разбирать дольше, чем честный отказ.
//
// Всё, что приходит из сети, сверяется с sha256 из каталога раздела. Не сошлось —
// установка останавливается, каталог голоса не создаётся.
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAttemptLog } from '../src/lib/showcase/attemptLog.ts';
import { installVoiceFiles } from '../src/lib/showcase/voice/download.ts';
import { runWithStdin } from '../src/lib/showcase/voice/process.ts';
import type { PiperVoicePackage } from '../src/lib/showcase/voice/piperCatalog.ts';

const SYNTH_SCRIPT = fileURLToPath(
  new URL('../src/lib/showcase/voice/piperSynth.py', import.meta.url),
);

// Фраза приёмки: обычные слова, числа и латиница. Она же читается человеком в
// отчёте, поэтому смысл у неё осмысленный, а не «раз два три».
const CHECK_PHRASE = 'Проверка голоса: раздел собирает ролик из трёх сцен.';
const MIN_CHECK_MS = 700;
const MIN_CHECK_PEAK = 0.01;

interface InstallTask {
  attemptId: string;
  workDir: string;
  voice: PiperVoicePackage;
  venvDir: string;
  voicesDir: string;
  requirementsFile: string;
  bootstrapPython: string;
  deadlineMs: number;
}

const taskFile = process.argv[2];

if (!taskFile) {
  console.error('showcaseVoiceInstall: не передан файл задания');
  process.exit(2);
}

const task = JSON.parse(await readFile(taskFile, 'utf8')) as InstallTask;
const { finish, report } = createAttemptLog(task);
const venvPython = path.join(task.venvDir, 'bin', 'python');

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

/**
 * Долгая команда с живым журналом. Вывод pip уходит в общий лог попытки, а в
 * строку прогресса — только последняя содержательная строка: человеку нужен
 * признак движения, а не весь поток.
 */
async function runLong(
  command: string,
  args: string[],
  step: string,
  label: string,
): Promise<void> {
  await report(step, label);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';

    const observe = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');

      process.stdout.write(text);

      const meaningful = text.split('\n').map((item) => item.trim()).filter(Boolean).at(-1);

      if (meaningful && meaningful !== tail) {
        tail = meaningful;
        void report(step, meaningful.slice(0, 120));
      }
    };

    child.stdout?.on('data', observe);
    child.stderr?.on('data', observe);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();

        return;
      }

      reject(new Error(`${path.basename(command)} завершился с кодом ${code}`));
    });
  });
}

/**
 * Приёмка: голос произносит контрольную фразу, и файл проверяется по длительности
 * и громкости. Тишина нужной длины — самый частый способ «установить» неработающий
 * синтез, и пройти приёмку она не должна.
 */
async function checkVoice(pack: PiperVoicePackage, voiceDir: string): Promise<void> {
  await report('check', 'проверяю синтезом');

  const sample = path.join(task.workDir, 'check.wav');
  // Фраза уходит на stdin тем же способом, что и в рабочем синтезе: приёмка
  // должна проверять тот путь, которым потом пойдёт озвучка.
  const produced = await runWithStdin(
    venvPython,
    [
      SYNTH_SCRIPT,
      '--model', path.join(voiceDir, pack.modelName),
      '--config', path.join(voiceDir, pack.configName),
      '--out', sample,
    ],
    { input: CHECK_PHRASE, timeoutMs: 120_000 },
  );
  const facts = JSON.parse(produced.stdout.trim().split('\n').at(-1) ?? '{}') as {
    durationMs?: number;
    peak?: number | null;
  };

  if ((facts.durationMs ?? 0) < MIN_CHECK_MS) {
    throw new Error(`контрольная фраза вышла длиной ${facts.durationMs ?? 0} мс`);
  }

  if (typeof facts.peak === 'number' && facts.peak < MIN_CHECK_PEAK) {
    throw new Error('контрольная фраза оказалась тишиной');
  }

  await report('check', `контрольная фраза: ${facts.durationMs} мс`);
}

const deadline = setTimeout(() => {
  void finish({ state: 'failed', error: 'установка не уложилась в срок' }).then(() => {
    process.exit(1);
  });
}, task.deadlineMs);

deadline.unref?.();

try {
  await mkdir(task.voicesDir, { recursive: true, mode: 0o700 });

  if (!await exists(venvPython)) {
    await runLong(task.bootstrapPython, ['-m', 'venv', task.venvDir], 'venv', 'создаю окружение');
  } else {
    await report('venv', 'окружение уже есть');
  }

  await runLong(
    venvPython,
    [
      '-m', 'pip', 'install',
      '--disable-pip-version-check',
      '--retries', '5',
      '--timeout', '30',
      '-r', task.requirementsFile,
    ],
    'packages',
    'ставлю движок синтеза',
  );

  const voiceDir = await installVoiceFiles(task.voice, task.voicesDir, report);

  await writeFile(
    path.join(voiceDir, 'voice.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      id: task.voice.id,
      name: task.voice.name,
      language: task.voice.language,
      timbre: task.voice.timbre,
      model: task.voice.modelName,
      config: task.voice.configName,
      sampleRate: task.voice.sampleRate,
      license: task.voice.license,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  try {
    await checkVoice(task.voice, voiceDir);
  } catch (error) {
    // Не прошедший приёмку голос снимается: «установлен» обязано значить
    // «говорит», иначе отказ всплывёт посреди первой же озвучки.
    await rm(path.join(voiceDir, 'voice.json'), { force: true });

    throw error;
  }

  await report('done', 'голос готов');
  await finish({ state: 'succeeded', voiceId: task.voice.id });
  process.exit(0);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);

  await report('failed', reason);
  await finish({ state: 'failed', error: reason });
  process.exit(1);
}
