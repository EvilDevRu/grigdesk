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
import { randomUUID } from 'node:crypto';
import {
    existsSync, mkdirSync, statSync, rmSync, readdirSync, writeFileSync, readFileSync,
    renameSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VENV_PYTHON } from './preflight.js';
import { normalizeSpeechOptions } from '../speech/options.js';
import { speechModelMissing, speechUnavailable } from '../speech/errors.js';
import {
    buildTranscribeArgv,
    decodeIngestJob,
    encodeIngestJob,
    pythonEnv,
} from '../speech/transport.js';

// transcribe.py лежит рядом с этим файлом (перенесён вместе с медиа-кодом).
export const DEFAULT_TRANSCRIBE_PY = process.env.COCKPIT_TRANSCRIBE_PY
    || fileURLToPath(new URL('./transcribe.py', import.meta.url));
export const DEFAULT_WORKER_JS = fileURLToPath(new URL('./ingest-worker.js', import.meta.url));
export const DEFAULT_MEDIA_HF_DIR = process.env.COCKPIT_MEDIA_HF_DIR
    || fileURLToPath(new URL('../../../.state/hf/', import.meta.url));

/**
 * Promisified spawn: собирает stdout/stderr, реджектит при ненулевом коде.
 */
export function runProcess(cmd, args, { cwd = undefined, env = undefined, signal = undefined } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, env, signal });
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
                const error = new Error(`${cmd} завершился с кодом ${code}: ${err.slice(-600)}`);
                error.exitCode = code;
                error.stderr = err;
                error.command = cmd;
                reject(error);
            }
        });
    });
}

/**
 * ffprobe: длительность (сек) и наличие аудио-дорожки.
 */
async function probe(file, runner, signal = undefined) {
    const { out } = await runner('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-show_entries', 'stream=codec_type',
        '-of', 'json',
        file,
    ], { signal });
    const j = JSON.parse(out || '{}');
    const duration = parseFloat(j.format?.duration ?? '0') || 0;
    const hasAudio = (j.streams || []).some((s) => s.codec_type === 'audio');
    return { duration, hasAudio };
}

/**
 * Извлечение моно-аудио 16 кГц в wav — формат, который любит faster-whisper.
 */
async function extractAudio(file, destDir, runner, signal = undefined) {
    const wav = join(destDir, 'audio.wav');
    await runner('ffmpeg', [
        '-y', '-i', file,
        '-vn',                     // без видео
        '-ac', '1',                // моно
        '-ar', '16000',            // 16 кГц
        '-c:a', 'pcm_s16le',
        wav,
    ], { signal });
    return wav;
}

/**
 * Кадры по смене сцены (для экрана/демонстраций). Не критично: при ошибке вернёт [].
 */
async function extractFrames(file, destDir, maxFrames, runner, signal = undefined) {
    await runner('ffmpeg', [
        '-y', '-i', file,
        '-an',                                                 // без аудио
        '-vf', "select='gt(scene,0.4)',scale=1280:-2",         // смена сцены + даунскейл
        '-vsync', 'vfr',
        '-frames:v', String(maxFrames),
        '-q:v', '3',
        join(destDir, 'frame-%03d.jpg'),
    ], { signal });
    return readdirSync(destDir)
        .filter((f) => /^frame-\d+\.jpg$/.test(f))
        .sort()
        .map((f) => join(destDir, f));
}

/**
 * Кадры равномерно по всей длительности — основной путь для записи экрана.
 *
 * Детектор сцен на скринкасте бесполезен: изменение занимает крошечную долю
 * кадра, и порог его не спасает (замер на синтетической записи «таблица →
 * активный чекбокс»: `gt(scene,0.4)` и даже `gt(scene,0.1)` дают НОЛЬ кадров).
 * Раньше отсюда падали в «первый кадр», и модель получала начало ролика, где
 * действие ещё не началось — то есть про само видео не узнавала ничего.
 *
 * Кадр берётся из СЕРЕДИНЫ своего интервала: нулевая секунда записи экрана —
 * это ещё не начатое действие. Отдельный seek на кадр, а не один `fps`-фильтр:
 * так момент каждого кадра задан явно, а сбой одного не уносит остальные.
 */
async function extractSpanFrames(file, destDir, count, duration, runner, signal = undefined) {
    const frames = [];
    for (let i = 0; i < count; i += 1) {
        const at = (duration * (i + 0.5)) / count;
        const frame = join(destDir, `span-${String(i + 1).padStart(3, '0')}.jpg`);
        try {
            await runner('ffmpeg', [
                '-y',
                '-ss', at.toFixed(3),
                '-i', file,
                '-an', '-frames:v', '1',
                '-vf', 'scale=1280:-2',
                '-q:v', '3',
                frame,
            ], { signal });
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
            continue;
        }
        if (existsSync(frame)) frames.push(frame);
    }
    return frames;
}

/**
 * Ограниченный набор кадров для других локальных потребителей media runtime
 * (например, разбора видео из Inbox). Исходный файл не покидает хост, а
 * вызывающий владеет destDir и его очисткой.
 *
 * Сцены остаются приоритетом (у смонтированного ролика они содержательны), но
 * недобор ВСЕГДА дополняется равномерной выборкой: раньше она включалась
 * только при полном нуле сцен, поэтому одна случайно найденная смена оставляла
 * ролик с единственным кадром.
 */
export async function extractSceneFrames({
    filePath,
    destDir,
    maxFrames = 4,
    signal = undefined,
}, deps = {}) {
    if (!existsSync(filePath)) throw new Error(`Файл не найден: ${filePath}`);
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 12) {
        throw new TypeError('maxFrames должен быть целым 1..12');
    }
    mkdirSync(destDir, { recursive: true });
    const runner = deps.runProcess || runProcess;
    let frames = [];
    try {
        frames = await extractFrames(filePath, destDir, maxFrames, runner, signal);
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
    }
    if (frames.length >= maxFrames) return frames;

    let duration = 0;
    try {
        ({ duration } = await probe(filePath, runner, signal));
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
    }
    if (duration > 0) {
        const span = await extractSpanFrames(
            filePath,
            destDir,
            maxFrames - frames.length,
            duration,
            runner,
            signal,
        );
        if (frames.length + span.length) return [...frames, ...span];
    }
    if (frames.length) return frames;

    // Длительность не прочиталась (битый контейнер, ffprobe недоступен) — остаётся
    // хотя бы первый кадр: иначе такое видео считалось бы неразбираемым вовсе.
    const fallback = join(destDir, 'frame-001.jpg');
    await runner('ffmpeg', [
        '-y', '-i', filePath,
        '-an', '-frames:v', '1',
        '-vf', 'scale=1280:-2',
        '-q:v', '3',
        fallback,
    ], { signal });
    return existsSync(fallback) ? [fallback] : [];
}

/**
 * Распознавание речи через transcribe.py в venv. progressFile (опц.) — куда python
 * пишет {done,total} по ходу, чтобы воркер мог показывать прогресс.
 */
async function transcribe(wav, {
    speech,
    progressFile = null,
    pythonPath,
    transcribePath,
    mediaHfDir,
    baseEnv,
    signal,
    runner,
}) {
    const argv = buildTranscribeArgv({
        scriptPath: transcribePath,
        audioPath: wav,
        options: speech,
        progressFile,
    });
    const env = pythonEnv({ mediaHfDir, pythonPath, baseEnv });
    let out;
    try {
        ({ out } = await runner(pythonPath, argv, { env, signal }));
    } catch (error) {
        const details = `${error?.stderr || ''}\n${error?.message || ''}`;
        if (/LocalEntryNotFoundError|appropriate cached snapshot|local_files_only.+(?:true|set)/i.test(details)) {
            throw speechModelMissing(`Локальная модель ${speech.model} не найдена в кэше`, error);
        }
        if (/No module named ['"]faster_whisper|ModuleNotFoundError.+faster_whisper/i.test(details)) {
            throw speechUnavailable('В media-venv не установлен faster-whisper', error);
        }
        throw error;
    }
    return JSON.parse(out);
}

/**
 * Полный разбор одного файла.
 *
 * @param {{filePath: string, workDir: string, speech?: object, model?: string, lang?: string, frames?: number}} opts
 * @returns {Promise<{sizeBytes: number, duration: number, transcript: object, frameFiles: string[]}>}
 */
export async function ingestRecording(opts, deps = {}) {
    const {
        filePath,
        workDir,
        frames = 0,
        pythonPath = VENV_PYTHON,
        transcribePath = DEFAULT_TRANSCRIBE_PY,
        mediaHfDir = DEFAULT_MEDIA_HF_DIR,
        baseEnv = process.env,
        signal = undefined,
    } = opts;
    const runner = deps.runProcess || runProcess;
    const speech = normalizeSpeechOptions(opts.speech ?? opts.options ?? {
        scenario: 'dictation',
        model: opts.model,
        language: opts.language ?? opts.lang,
        device: opts.device,
        computeType: opts.computeType,
        beamSize: opts.beamSize,
        hotwords: opts.hotwords,
        vadSilenceMs: opts.vadSilenceMs,
        conditionOnPreviousText: opts.conditionOnPreviousText,
    }, 'dictation');
    if (!existsSync(filePath)) {
        throw new Error(`Файл не найден: ${filePath}`);
    }
    // Про ненастроенное окружение говорим ДО ffmpeg: иначе минуты работы уходят впустую, а
    // человек в чате видит только сырое `spawn ... ENOENT` от python и не понимает, что чинить.
    if (!pythonPath || !existsSync(pythonPath)) {
        throw speechUnavailable(
            `Распознавание речи не настроено: ${pythonPath
                ? `python не найден по COCKPIT_MEDIA_PYTHON (${pythonPath})`
                : 'не задан COCKPIT_MEDIA_PYTHON (путь к python из venv с faster-whisper)'
            }. Подробности и что сделать — GET /api/media/doctor.`,
        );
    }
    mkdirSync(workDir, { recursive: true });

    const sizeBytes = statSync(filePath).size;
    const { duration, hasAudio } = await probe(filePath, runner, signal);
    if (!hasAudio) {
        throw new Error('В файле нет аудио-дорожки — распознавать нечего.');
    }

    const wav = await extractAudio(filePath, workDir, runner, signal);
    const transcript = await transcribe(wav, {
        speech,
        progressFile: join(workDir, 'progress.json'),
        pythonPath,
        transcribePath: transcribePath || DEFAULT_TRANSCRIBE_PY,
        mediaHfDir,
        baseEnv,
        signal,
        runner,
    });

    let frameFiles = [];
    if (frames > 0) {
        try {
            frameFiles = await extractFrames(filePath, workDir, frames, runner, signal);
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

/** Status содержит пути и словарь терминов: пишем атомарно и независимо от umask. */
export function writeIngestJobFile(statusPath, value, deps = {}) {
    const write = deps.writeFileSync || writeFileSync;
    const rename = deps.renameSync || renameSync;
    const unlink = deps.unlinkSync || unlinkSync;
    const encoded = encodeIngestJob(value);
    const temp = `${statusPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
        write(temp, JSON.stringify(encoded), { mode: 0o600 });
        rename(temp, statusPath);
    } catch (error) {
        try { unlink(temp); } catch { /* temp мог не появиться */ }
        throw error;
    }
    return encoded;
}

/**
 * Запускает распознавание ОТДЕЛЬНЫМ фоновым процессом и сразу возвращает jobId.
 * Состояние пишется в `<jobsDir>/<jobId>.json` (status: running|done|failed),
 * опрашивается через readIngestJob. Так MCP-вызов не блокируется на минуты.
 *
 * @returns {{jobId: string, statusPath: string}}
 */
export function startIngestJob(opts, deps = {}) {
    const {
        filePath,
        workDir,
        frames = 0,
        jobsDir,
        pythonPath = VENV_PYTHON,
        transcribePath = DEFAULT_TRANSCRIBE_PY,
        mediaHfDir = DEFAULT_MEDIA_HF_DIR,
        baseEnv = process.env,
        workerPath = DEFAULT_WORKER_JS,
    } = opts;
    if (!existsSync(filePath)) {
        throw new Error(`Файл не найден: ${filePath}`);
    }
    mkdirSync(jobsDir, { recursive: true });

    const now = deps.now || Date.now;
    const jobId = (deps.createJobId || randomUUID)();
    const statusPath = jobStatusPath(jobsDir, jobId);
    const speech = normalizeSpeechOptions(opts.speech ?? opts.options ?? {
        scenario: 'video',
        model: opts.model,
        language: opts.language ?? opts.lang,
        device: opts.device,
        computeType: opts.computeType,
        beamSize: opts.beamSize,
        hotwords: opts.hotwords,
        vadSilenceMs: opts.vadSilenceMs,
        conditionOnPreviousText: opts.conditionOnPreviousText,
    }, 'video');
    const job = encodeIngestJob({
        jobId,
        status: 'running',
        filePath,
        workDir,
        frames,
        speech,
        runtime: { pythonPath, transcribePath: transcribePath || DEFAULT_TRANSCRIBE_PY, mediaHfDir },
        startedAt: now(),
        finishedAt: null,
        result: null,
        error: null,
    });
    writeIngestJobFile(statusPath, job, deps);

    // Детач: воркер живёт независимо от MCP-вызова, который сейчас вернётся.
    const childEnv = pythonEnv({ mediaHfDir, pythonPath, baseEnv });
    if (pythonPath) childEnv.COCKPIT_MEDIA_PYTHON = pythonPath;
    childEnv.COCKPIT_TRANSCRIBE_PY = transcribePath || DEFAULT_TRANSCRIBE_PY;
    childEnv.COCKPIT_MEDIA_HF_DIR = mediaHfDir;
    const child = (deps.spawn || spawn)(process.execPath, [workerPath, statusPath], {
        detached: true,
        stdio: 'ignore',
        env: childEnv,
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
export async function extractFramesAt({ filePath, seconds, destDir }, deps = {}) {
    if (!existsSync(filePath)) {
        throw new Error(`Файл не найден: ${filePath}`);
    }
    mkdirSync(destDir, { recursive: true });
    const out = [];
    for (const sec of seconds) {
        const tag = String(Math.round(sec)).padStart(5, '0');
        const dst = join(destDir, `frame-${tag}s.jpg`);
        // -ss до -i = быстрый input-seek; один кадр, даунскейл до 1280.
        await (deps.runProcess || runProcess)('ffmpeg', [
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
        return decodeIngestJob(readFileSync(statusPath, 'utf-8'));
    } catch {
        // файл могли писать в момент чтения — пусть опросят ещё раз
        return null;
    }
}
