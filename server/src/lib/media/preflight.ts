// Предполётная проверка окружения для разбора видеозаписей встреч.
//
// Разбор видео опирается на внешние вещи: системный ffmpeg/ffprobe (извлечение
// аудио и кадров) и Python-окружение с faster-whisper (распознавание речи).
// Если чего-то нет — инструмент должен сообщить ЧТО именно и КАК поставить,
// а не падать с непонятной ошибкой посреди обработки.
//
// Используется двумя способами:
//   • инструмент b24_media_doctor — проверить состояние в любой момент;
//   • в начале b24_ingest_recording — отказать с инструкцией, если не готово.

import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { dataHome, dataPath } from '../../../../shared/runtime/dataHome.ts';

export const AUDIO_PROBE_PY = fileURLToPath(new URL('./audio-probe.py', import.meta.url));

// Одна проверка окружения: что именно не готово и чем это чинится. Пара
// «отказ + шаг починки» неразделима — без второго человеку некуда идти.
export interface PreflightCheck {
    name: string;
    ok: boolean;
    fix: string;
}

export interface PreflightReport {
    ok: boolean;
    checks: PreflightCheck[];
    venvPython: string;
}

// Python из venv с faster-whisper. Путь приходит из окружения: рекомендуемый
// state/media-venv в папке данных создаёт deploy/install.sh, но custom path остаётся допустим.
// Модели в размер venv не входят и лежат в отдельном GRIGDESK_MEDIA_HF_DIR.
//
// Runtime-функции получают pythonPath явно из SpeechRuntime; эта константа нужна только
// legacy-вызовам. Раньше тут был fallback на
// `<каталог файла>/../.venv/bin/python` — наследство прежней раскладки, где файл лежал в
// src/media/ и `..` попадал в корень внешнего проекта. После переезда в server/src/lib/media/ он стал
// указывать на server/src/lib/.venv, которого нет и не будет: вместо внятного «не настроено»
// диктовка отвечала `spawn .../lib/.venv/bin/python ENOENT`.
export const VENV_PYTHON = process.env.GRIGDESK_MEDIA_PYTHON || '';

/**
 * Проверяет, что бинарь существует в PATH (по коду ошибки ENOENT при spawn).
 */
function commandPresent(cmd: string, args: string[] = ['-version'], {
    env = process.env,
    spawn = spawnSync,
}: { env?: NodeJS.ProcessEnv; spawn?: typeof spawnSync } = {}): boolean {
    const r = spawn(cmd, args, { stdio: 'ignore', env });

    return !(r.error && (r.error as { code?: unknown }).code === 'ENOENT');
}

/**
 * Прогоняет все проверки окружения и возвращает структурированный отчёт.
 *
 * @returns {{ok: boolean, checks: Array<{name: string, ok: boolean, fix: string}>, venvPython: string}}
 */
export function preflight({
    pythonPath = VENV_PYTHON,
    env = process.env,
    spawn = spawnSync,
    pathExists = existsSync,
}: {
    pythonPath?: string;
    env?: NodeJS.ProcessEnv;
    spawn?: typeof spawnSync;
    pathExists?: (path: string) => boolean;
} = {}): PreflightReport {
    const checks: PreflightCheck[] = [];

    const ffmpeg = commandPresent('ffmpeg', ['-version'], { env, spawn });
    checks.push({
        name: 'ffmpeg (извлечение аудио/кадров)',
        ok: ffmpeg,
        fix: 'sudo apt install -y ffmpeg',
    });

    const ffprobe = commandPresent('ffprobe', ['-version'], { env, spawn });
    checks.push({
        name: 'ffprobe (длительность/метаданные)',
        ok: ffprobe,
        fix: 'sudo apt install -y ffmpeg   (ffprobe идёт в том же пакете)',
    });

    const venv = Boolean(pythonPath) && pathExists(pythonPath);

    checks.push({
        name: pythonPath
            ? `python venv (${pythonPath})`
            : 'python venv (GRIGDESK_MEDIA_PYTHON не задан)',
        ok: venv,
        fix: 'GRIGDESK_MEDIA_PYTHON=<путь к venv>/bin/python в .env папки данных + перезапуск сервера',
    });

    // Проверяем файловый декодер: импорт не выявляет несовместимость faster-whisper и PyAV.
    const whisper = venv && spawn(pythonPath, [AUDIO_PROBE_PY], { stdio: 'ignore', env }).status === 0;

    checks.push({
        name: 'faster-whisper (распознавание речи)',
        ok: whisper,
        fix: 'deploy/install.sh --no-cuda (или --with-cuda) — восстановит закреплённый media runtime',
    });

    return { ok: checks.every((c) => c.ok), checks, venvPython: pythonPath };
}

// Внешний процесс проверяется исходом, а не разбором вывода: «нет бинаря» и
// «бинарь отказал» ведут человека к разным шагам починки.
function exitStatus(cmd: string, args: string[], {
    env = process.env,
    spawn = spawnProcess,
}: { env?: NodeJS.ProcessEnv; spawn?: typeof spawnProcess } = {}) {
    return new Promise<{ ok: boolean; error?: unknown; status?: number | null }>((resolve) => {
        let child: ReturnType<typeof spawnProcess>;

        try {
            child = spawn(cmd, args, { stdio: 'ignore', env });
        } catch (error) {
            resolve({ ok: false, error });
            return;
        }
        child.once('error', (error: unknown) => resolve({ ok: false, error }));
        child.once('close', (status: number | null) => resolve({ ok: status === 0, status }));
    });
}

/** Та же форма отчёта без блокировки event loop на внешних процессах. */
export async function preflightAsync({
    pythonPath = VENV_PYTHON,
    env = process.env,
    spawn = spawnProcess,
    pathExists = existsSync,
}: {
    pythonPath?: string;
    env?: NodeJS.ProcessEnv;
    spawn?: typeof spawnProcess;
    pathExists?: (path: string) => boolean;
} = {}): Promise<PreflightReport> {
    const venv = Boolean(pythonPath) && pathExists(pythonPath);
    const [ffmpeg, ffprobe, whisper] = await Promise.all([
        exitStatus('ffmpeg', ['-version'], { env, spawn }),
        exitStatus('ffprobe', ['-version'], { env, spawn }),
        venv
            ? exitStatus(pythonPath, [AUDIO_PROBE_PY], { env, spawn })
            : Promise.resolve({ ok: false }),
    ]);
    const checks: PreflightCheck[] = [
        {
            name: 'ffmpeg (извлечение аудио/кадров)',
            ok: ffmpeg.ok,
            fix: 'sudo apt install -y ffmpeg',
        },
        {
            name: 'ffprobe (длительность/метаданные)',
            ok: ffprobe.ok,
            fix: 'sudo apt install -y ffmpeg   (ffprobe идёт в том же пакете)',
        },
        {
            name: pythonPath
                ? `python venv (${pythonPath})`
                : 'python venv (GRIGDESK_MEDIA_PYTHON не задан)',
            ok: venv,
            fix: 'GRIGDESK_MEDIA_PYTHON=<путь к venv>/bin/python в .env папки данных + перезапуск сервера',
        },
        {
            name: 'faster-whisper (распознавание речи)',
            ok: whisper.ok,
            fix: 'deploy/install.sh --no-cuda (или --with-cuda) — восстановит закреплённый media runtime',
        },
    ];
    return { ok: checks.every((check) => check.ok), checks, venvPython: pythonPath };
}

/**
 * Человекочитаемый отчёт по результату preflight() с инструкциями по недостающему.
 */
export function preflightReport(pf: PreflightReport): string {
    const lines = pf.checks.map((c) => `  ${c.ok ? '✅' : '❌'} ${c.name}`);
    if (pf.ok) {
        return ['🩺 Окружение для разбора видео готово:', ...lines].join('\n');
    }
    // Уникальные шаги починки в порядке появления (apt раньше настройки путей).
    const fixes = [...new Set(pf.checks.filter((c) => !c.ok).map((c) => c.fix))];
    // При ручном обходе deploy/install.sh подсказываем воспроизводимый локальный путь.
    const venvMissing = pf.checks.some((c) => c.name.startsWith('python venv') && !c.ok);
    const venv = dataPath(dataHome({ env: process.env, home: os.homedir() }), 'mediaVenv');
    const notes = venvMissing
        ? ['', 'Штатно: deploy/install.sh --no-cuda (или --with-cuda). '
            + `Вручную: python3 -m venv ${venv} && ${venv}/bin/pip install -r server/requirements-media.txt`]
        : [];
    return [
        '🩺 Окружение для разбора видео НЕ готово:',
        ...lines,
        '',
        'Что сделать:',
        ...fixes.map((f) => `  • ${f}`),
        ...notes,
    ].join('\n');
}
