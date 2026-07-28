// Локальный разбор видеозаписи встречи: извлечение речи (транскрипт с тайм-кодами)
// и опционально кадров со сменой сцены. Видео НЕ покидает хост и не передаётся
// ассистенту целиком — наружу идут только текст транскрипта и мелкие кадры.
//
// Конвейер:
//   ffprobe        — длительность + проверка наличия аудио-дорожки
//   ffmpeg → wav   — 16 кГц mono (300 МБ видео → несколько МБ звука)
//   transcribe.py  — faster-whisper, JSON с тайм-кодами
//   ffmpeg → jpg   — (опц.) кадры по смене сцены (показанные на экране страницы/макеты)

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VENV_PYTHON } from './preflight.js';

// transcribe.py лежит рядом с этим файлом (перенесён вместе с медиа-кодом).
const TRANSCRIBE_PY = process.env.COCKPIT_TRANSCRIBE_PY || fileURLToPath(new URL('./transcribe.py', import.meta.url));
const WORKER_JS = fileURLToPath(new URL('./ingest-worker.js', import.meta.url));

/**
 * Promisified spawn: собирает stdout/stderr, реджектит при ненулевом коде.
 */
function run(cmd, args, { cwd = undefined } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => {
            out += d;
        });
        child.stderr.on('data', (d) => {
            err += d;
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ out, err });
            } else {
                reject(new Error(`${cmd} завершился с кодом ${code}: ${err.slice(-600)}`));
            }
        });
    });
}

/**
 * ffprobe: длительность (сек) и наличие аудио-дорожки.
 */
async function probe(file) {
    const { out } = await run('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-show_entries', 'stream=codec_type',
        '-of', 'json',
        file,
    ]);
    const j = JSON.parse(out || '{}');
    const duration = parseFloat(j.format?.duration ?? '0') || 0;
    const hasAudio = (j.streams || []).some((s) => s.codec_type === 'audio');
    return { duration, hasAudio };
}

/**
 * Извлечение моно-аудио 16 кГц в wav — формат, который любит faster-whisper.
 */
async function extractAudio(file, destDir) {
    const wav = join(destDir, 'audio.wav');
    await run('ffmpeg', [
        '-y', '-i', file,
        '-vn',                     // без видео
        '-ac', '1',                // моно
        '-ar', '16000',            // 16 кГц
        '-c:a', 'pcm_s16le',
        wav,
    ]);
    return wav;
}

/**
 * Кадры по смене сцены (для экрана/демонстраций). Не критично: при ошибке вернёт [].
 */
async function extractFrames(file, destDir, maxFrames) {
    await run('ffmpeg', [
        '-y', '-i', file,
        '-an',                                                 // без аудио
        '-vf', "select='gt(scene,0.4)',scale=1280:-2",         // смена сцены + даунскейл
        '-vsync', 'vfr',
        '-frames:v', String(maxFrames),
        '-q:v', '3',
        join(destDir, 'frame-%03d.jpg'),
    ]);
    return readdirSync(destDir)
        .filter((f) => /^frame-\d+\.jpg$/.test(f))
        .sort()
        .map((f) => join(destDir, f));
}

/**
 * Распознавание речи через transcribe.py в venv. progressFile (опц.) — куда python
 * пишет {done,total} по ходу, чтобы воркер мог показывать прогресс.
 */
async function transcribe(wav, { model, lang, progressFile = null }) {
    const argv = [TRANSCRIBE_PY, wav, '--model', model, '--lang', lang];
    if (progressFile) {
        argv.push('--progress-file', progressFile);
    }
    const { out } = await run(VENV_PYTHON, argv);
    return JSON.parse(out);
}

/**
 * Полный разбор одного файла.
 *
 * @param {{filePath: string, workDir: string, model?: string, lang?: string, frames?: number}} opts
 * @returns {Promise<{sizeBytes: number, duration: number, transcript: object, frameFiles: string[]}>}
 */
export async function ingestRecording({ filePath, workDir, model = 'medium', lang = 'ru', frames = 0 }) {
    if (!existsSync(filePath)) {
        throw new Error(`Файл не найден: ${filePath}`);
    }
    // Про ненастроенное окружение говорим ДО ffmpeg: иначе минуты работы уходят впустую, а
    // человек в чате видит только сырое `spawn ... ENOENT` от python и не понимает, что чинить.
    if (!VENV_PYTHON || !existsSync(VENV_PYTHON)) {
        throw new Error(
            `Распознавание речи не настроено: ${VENV_PYTHON
                ? `python не найден по COCKPIT_MEDIA_PYTHON (${VENV_PYTHON})`
                : 'не задан COCKPIT_MEDIA_PYTHON (путь к python из venv с faster-whisper)'
            }. Подробности и что сделать — GET /api/media/doctor.`,
        );
    }
    mkdirSync(workDir, { recursive: true });

    const sizeBytes = statSync(filePath).size;
    const { duration, hasAudio } = await probe(filePath);
    if (!hasAudio) {
        throw new Error('В файле нет аудио-дорожки — распознавать нечего.');
    }

    const wav = await extractAudio(filePath, workDir);
    const transcript = await transcribe(wav, { model, lang, progressFile: join(workDir, 'progress.json') });

    let frameFiles = [];
    if (frames > 0) {
        try {
            frameFiles = await extractFrames(filePath, workDir, frames);
        } catch {
            // Видео без выраженных смен сцены или без видеодорожки — кадры просто пропускаем.
            frameFiles = [];
        }
    }

    // Большой wav больше не нужен — чистим, кадры оставляем.
    try {
        rmSync(wav);
    } catch {
        // не страшно, если не удалилось
    }

    return { sizeBytes, duration, transcript, frameFiles };
}

/**
 * Путь к JSON-файлу состояния задачи распознавания.
 */
function jobStatusPath(jobsDir, jobId) {
    return join(jobsDir, `${jobId}.json`);
}

/**
 * Запускает распознавание ОТДЕЛЬНЫМ фоновым процессом и сразу возвращает jobId.
 * Состояние пишется в `<jobsDir>/<jobId>.json` (status: running|done|failed),
 * опрашивается через readIngestJob. Так MCP-вызов не блокируется на минуты.
 *
 * @returns {{jobId: string, statusPath: string}}
 */
export function startIngestJob({ filePath, workDir, model = 'medium', lang = 'ru', frames = 0, jobsDir }) {
    if (!existsSync(filePath)) {
        throw new Error(`Файл не найден: ${filePath}`);
    }
    mkdirSync(jobsDir, { recursive: true });

    const jobId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const statusPath = jobStatusPath(jobsDir, jobId);
    const job = {
        jobId,
        status: 'running',
        filePath,
        workDir,
        model,
        lang,
        frames,
        startedAt: Date.now(),
        finishedAt: null,
        result: null,
        error: null,
    };
    writeFileSync(statusPath, JSON.stringify(job));

    // Детач: воркер живёт независимо от MCP-вызова, который сейчас вернётся.
    const child = spawn(process.execPath, [WORKER_JS, statusPath], {
        detached: true,
        stdio: 'ignore',
    });
    child.unref();

    return { jobId, statusPath };
}

/**
 * Извлекает кадры в КОНКРЕТНЫЕ секунды видео (для скриншотов под задачи).
 * Всё локально (ffmpeg в том же окружении) — видео не покидает сервер.
 *
 * @param {{filePath: string, seconds: number[], destDir: string}} opts
 * @returns {Promise<Array<{seconds: number, path: string}>>}
 */
export async function extractFramesAt({ filePath, seconds, destDir }) {
    if (!existsSync(filePath)) {
        throw new Error(`Файл не найден: ${filePath}`);
    }
    mkdirSync(destDir, { recursive: true });
    const out = [];
    for (const sec of seconds) {
        const tag = String(Math.round(sec)).padStart(5, '0');
        const dst = join(destDir, `frame-${tag}s.jpg`);
        // -ss до -i = быстрый input-seek; один кадр, даунскейл до 1280.
        await run('ffmpeg', [
            '-y', '-ss', String(sec), '-i', filePath,
            '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', dst,
        ]);
        out.push({ seconds: sec, path: dst });
    }
    return out;
}

/**
 * Читает состояние задачи распознавания. null — если задачи нет.
 */
export function readIngestJob(jobId, jobsDir) {
    const statusPath = jobStatusPath(jobsDir, jobId);
    if (!existsSync(statusPath)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(statusPath, 'utf-8'));
    } catch {
        // файл могли писать в момент чтения — пусть опросят ещё раз
        return null;
    }
}
