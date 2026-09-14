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

import { VENV_PYTHON } from './preflight.ts';
import { readProcessIdentity } from '../speech/modelJobsProcess.ts';
import { normalizeSpeechOptions } from '../speech/options.ts';
import { speechModelMissing, speechUnavailable } from '../speech/errors.ts';
import {
    buildTranscribeArgv,
    decodeSpeechTranscript,
    decodeIngestJob,
    encodeIngestJob,
    pythonEnv,
} from '../speech/transport.ts';

// Что вернул внешний процесс. Оба потока нужны целиком: stdout несёт JSON
// распознавания, а stderr — единственное объяснение отказа ffmpeg или python.
export interface ProcessResult {
    out: string;
    err: string;
}

// Отказ внешнего процесса. Причину разбирают выше по стеку: «модели нет в кэше» и
// «в venv нет faster-whisper» различаются только текстом, который написал python.
export interface ProcessFailure extends Error {
    exitCode?: number | null;
    stderr?: string;
    command?: string;
}

// Запуск внешнего процесса. Объявлен типом, а не выведен из `runProcess`: его
// подменяют и проверки, и соседние потребители media runtime.
export type ProcessRunner = (
    cmd: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<ProcessResult>;

// Параметры речи собирает общий нормализатор (ещё JavaScript). Форма берётся у
// него, чтобы разбор и воркер не разошлись с ним на первой же новой настройке.
export type SpeechOptions = ReturnType<typeof normalizeSpeechOptions>;

// Расшифровка от transcribe.py. Поля разбирает вызывающий; здесь важно ровно то,
// что это объект с репликами, а не строка.
export interface Transcript {
    segments?: { start?: number; end?: number; text?: string }[];
    words?: { start?: number; end?: number; text?: string }[];
    wordTimestamps?: boolean;
    wordTimingStatus?: string;
    wordTimingReason?: string;
    language?: string;
    [field: string]: unknown;
}

// Результат разбора одного файла. `execution` дописывает воркер: без пометки об
// откате с CUDA на CPU «почему так медленно» разбирать нечем.
export interface IngestResult {
    sizeBytes: number;
    duration: number;
    transcript: Transcript;
    frameFiles: string[];
    execution?: {
        engine: string;
        mode: string;
        device: string;
        fallback: string;
    };
}

// Вход разбора. Кроме явных полей принимает старые псевдонимы параметров речи
// (`options`, `lang`, отдельные ключи): ими зовут разбор и MCP-инструмент.
export interface IngestOptions {
    filePath: string;
    workDir: string;
    frames?: number;
    pythonPath?: string;
    transcribePath?: string;
    mediaHfDir?: string;
    baseEnv?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    speech?: SpeechOptions;
    options?: SpeechOptions;
    model?: string;
    language?: string;
    lang?: string;
    device?: string;
    computeType?: string;
    beamSize?: number;
    hotwords?: string;
    vadSilenceMs?: number;
    conditionOnPreviousText?: boolean;
    initialPrompt?: string;
    wordTimestamps?: boolean;
}

export interface IngestJobOptions extends IngestOptions {
    jobsDir: string;
    workerPath?: string;
}

// Состояние задачи распознавания на диске. У транспорта своя, более узкая форма
// (`result`/`error` там ещё недоверенные): здесь поля объявлены ровно тем, чем их
// зовут разбор и сам воркер, поэтому порт остаётся отдельным.
export interface IngestJob {
    schemaVersion: number;
    jobId: string;
    status: string;
    filePath: string;
    workDir: string;
    frames: number;
    speech: SpeechOptions;
    runtime: { pythonPath?: string; transcribePath?: string; mediaHfDir?: string };
    startedAt: number;
    finishedAt: number | null;
    result: IngestResult | null;
    error: string | null;
    progress?: unknown;
}

// Кто считает эту задачу прямо сейчас. Одного PID мало: номер мог уже достаться
// постороннему процессу, поэтому рядом лежит момент старта из /proc. `starttime`
// бывает пустым, когда воркер умер быстрее, чем родитель успел его прочитать, —
// тогда живость решается по одному PID и трактуется в пользу задачи.
export interface IngestWorkerProcess {
    pid: number;
    starttime: string | null;
}

// Атомарная замена файла состояния делается тремя вызовами fs, и проверки
// подменяют каждый из них по отдельности.
export interface IngestFileDeps {
    writeFileSync?: typeof writeFileSync;
    renameSync?: typeof renameSync;
    unlinkSync?: typeof unlinkSync;
}

export interface IngestJobDeps extends IngestFileDeps {
    now?: () => number;
    createJobId?: () => string;
    spawn?: typeof spawn;
    readProcessIdentity?: (pid: number) => { starttime: string } | null;
}

// Чтение состояния умеет чинить брошенную задачу, поэтому ему нужны и часы,
// и запись файла, и способ узнать, жив ли записанный воркер.
export interface IngestJobReadDeps extends IngestFileDeps {
    now?: () => number;
    readProcessIdentity?: (pid: number) => { starttime: string } | null;
}

// Соседи разбора ещё на JavaScript, и вывод типов сужает их необязательные
// параметры до `undefined`, а обязательный `mediaHfDir` теряет вовсе. Каждая
// функция объявлена здесь ровно тем, чем её зовёт этот файл.
const buildPythonEnv = pythonEnv as (options: {
    mediaHfDir: string;
    pythonPath?: string;
    baseEnv?: NodeJS.ProcessEnv;
}) => NodeJS.ProcessEnv;

const buildArgv = buildTranscribeArgv as (options: {
    scriptPath: string;
    audioPath: string;
    options: SpeechOptions;
    progressFile?: string | null;
}) => string[];

const failModelMissing = speechModelMissing as (message: string, cause?: unknown) => Error;
const failUnavailable = speechUnavailable as (message: string, cause?: unknown) => Error;
const encodeJob = encodeIngestJob as (value: unknown) => IngestJob;
const decodeJob = decodeIngestJob as (value: unknown) => IngestJob;
const readIdentity = readProcessIdentity as (pid: number) => {
    pid: number;
    starttime: string;
    cmdline: string;
} | null;

// transcribe.py лежит рядом с этим файлом (перенесён вместе с медиа-кодом).
export const DEFAULT_TRANSCRIBE_PY = process.env.COCKPIT_TRANSCRIBE_PY
    || fileURLToPath(new URL('./transcribe.py', import.meta.url));
export const DEFAULT_WORKER_PATH = fileURLToPath(new URL('./ingestWorker.ts', import.meta.url));
export const DEFAULT_MEDIA_HF_DIR = process.env.COCKPIT_MEDIA_HF_DIR
    || fileURLToPath(new URL('../../../.state/hf/', import.meta.url));

/**
 * Promisified spawn: собирает stdout/stderr, реджектит при ненулевом коде.
 */
export function runProcess(cmd: string, args: string[], {
    cwd = undefined,
    env = undefined,
    signal = undefined,
}: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve, reject) => {
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
                const error: ProcessFailure = new Error(
                    `${cmd} завершился с кодом ${code}: ${err.slice(-600)}`,
                );
                error.exitCode = code;
                error.stderr = err;
                error.command = cmd;
                reject(error);
            }
        });
    });
}

// Отмена — не отказ инструмента: её пробрасывают дальше нетронутой, иначе разбор
// молча продолжится после того, как человек его остановил. Проверяется и сигнал, и
// сама ошибка: прерванный spawn приходит двумя разными именами.
function isAborted(error: unknown, signal?: AbortSignal): boolean {
    const failure = error as { name?: string; code?: string } | null;

    return Boolean(signal?.aborted)
        || failure?.name === 'AbortError'
        || failure?.code === 'ABORT_ERR';
}

/**
 * ffprobe: длительность (сек) и наличие аудио-дорожки.
 */
async function probe(
    file: string,
    runner: ProcessRunner,
    signal: AbortSignal | undefined = undefined,
): Promise<{ duration: number; hasAudio: boolean }> {
    const { out } = await runner('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-show_entries', 'stream=codec_type',
        '-of', 'json',
        file,
    ], { signal });
    const j = JSON.parse(out || '{}') as {
        format?: { duration?: string | number };
        streams?: { codec_type?: string }[];
    };
    const duration = parseFloat(String(j.format?.duration ?? '0')) || 0;
    const hasAudio = (j.streams || []).some((s) => s.codec_type === 'audio');
    return { duration, hasAudio };
}

/**
 * Извлечение моно-аудио 16 кГц в wav — формат, который любит faster-whisper.
 */
async function extractAudio(
    file: string,
    destDir: string,
    runner: ProcessRunner,
    signal: AbortSignal | undefined = undefined,
): Promise<string> {
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
async function extractFrames(
    file: string,
    destDir: string,
    maxFrames: number,
    runner: ProcessRunner,
    signal: AbortSignal | undefined = undefined,
): Promise<string[]> {
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
async function extractSpanFrames(
    file: string,
    destDir: string,
    count: number,
    duration: number,
    runner: ProcessRunner,
    signal: AbortSignal | undefined = undefined,
): Promise<string[]> {
    const frames: string[] = [];
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
            if (isAborted(error, signal)) throw error;
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
}: {
    filePath: string;
    destDir: string;
    maxFrames?: number;
    signal?: AbortSignal;
}, deps: { runProcess?: ProcessRunner } = {}): Promise<string[]> {
    if (!existsSync(filePath)) throw new Error(`Файл не найден: ${filePath}`);
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 12) {
        throw new TypeError('maxFrames должен быть целым 1..12');
    }
    mkdirSync(destDir, { recursive: true });
    const runner = deps.runProcess || runProcess;
    let frames: string[] = [];

    try {
        frames = await extractFrames(filePath, destDir, maxFrames, runner, signal);
    } catch (error) {
        if (isAborted(error, signal)) throw error;
    }
    if (frames.length >= maxFrames) return frames;

    let duration = 0;
    try {
        ({ duration } = await probe(filePath, runner, signal));
    } catch (error) {
        if (isAborted(error, signal)) throw error;
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
async function transcribe(wav: string, {
    speech,
    progressFile = null,
    pythonPath,
    transcribePath,
    mediaHfDir,
    baseEnv,
    signal,
    runner,
}: {
    speech: SpeechOptions;
    progressFile?: string | null;
    pythonPath: string;
    transcribePath: string;
    mediaHfDir: string;
    baseEnv?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    runner: ProcessRunner;
}): Promise<Transcript> {
    const argv = buildArgv({
        scriptPath: transcribePath,
        audioPath: wav,
        options: speech,
        progressFile,
    });
    const env = buildPythonEnv({ mediaHfDir, pythonPath, baseEnv });
    let out = '';

    try {
        ({ out } = await runner(pythonPath, argv, { env, signal }));
    } catch (error) {
        const failure = error as ProcessFailure;
        const details = `${failure?.stderr || ''}\n${failure?.message || ''}`;
        if (/LocalEntryNotFoundError|appropriate cached snapshot|local_files_only.+(?:true|set)/i.test(details)) {
            throw failModelMissing(`Локальная модель ${speech.model} не найдена в кэше`, error);
        }
        if (/No module named ['"]faster_whisper|ModuleNotFoundError.+faster_whisper/i.test(details)) {
            throw failUnavailable('В media-venv не установлен faster-whisper', error);
        }
        throw error;
    }
    return decodeSpeechTranscript(JSON.parse(out), {
        wordTimestampsRequested: speech.wordTimestamps || Boolean(speech.initialPrompt),
    });
}

/**
 * Полный разбор одного файла.
 *
 * @param {{filePath: string, workDir: string, speech?: object, model?: string, lang?: string, frames?: number}} opts
 * @returns {Promise<{sizeBytes: number, duration: number, transcript: object, frameFiles: string[]}>}
 */
export async function ingestRecording(
    opts: IngestOptions,
    deps: { runProcess?: ProcessRunner } = {},
): Promise<IngestResult> {
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
        wordTimestamps: opts.wordTimestamps,
    }, 'dictation');
    if (!existsSync(filePath)) {
        throw new Error(`Файл не найден: ${filePath}`);
    }
    // Про ненастроенное окружение говорим ДО ffmpeg: иначе минуты работы уходят впустую, а
    // человек в чате видит только сырое `spawn ... ENOENT` от python и не понимает, что чинить.
    if (!pythonPath || !existsSync(pythonPath)) {
        throw failUnavailable(
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

    let frameFiles: string[] = [];

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
function jobStatusPath(jobsDir: string, jobId: string): string {
    return join(jobsDir, `${jobId}.json`);
}

/**
 * Метка запущенного воркера лежит ОТДЕЛЬНО от состояния задачи. В общий файл её
 * писать нельзя: воркер читает состояние сразу после старта и своей записью
 * затёр бы метку, которую родитель дописал бы следом.
 */
function jobWorkerPath(jobsDir: string, jobId: string): string {
    return join(jobsDir, `${jobId}.worker.json`);
}

/**
 * Замена файла целиком: сначала временный сосед, потом rename. Половины записи
 * читатель не увидит, а режим задан явно — состояние задачи содержит пути.
 */
function writeJsonFile(filePath: string, value: unknown, deps: IngestFileDeps): void {
    const write = deps.writeFileSync || writeFileSync;
    const rename = deps.renameSync || renameSync;
    const unlink = deps.unlinkSync || unlinkSync;
    const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;

    try {
        write(temp, JSON.stringify(value), { mode: 0o600 });
        rename(temp, filePath);
    } catch (error) {
        try { unlink(temp); } catch { /* temp мог не появиться */ }
        throw error;
    }
}

/** Status содержит пути и словарь терминов: пишем атомарно и независимо от umask. */
export function writeIngestJobFile(
    statusPath: string,
    value: unknown,
    deps: IngestFileDeps = {},
): IngestJob {
    const encoded = encodeJob(value);

    writeJsonFile(statusPath, encoded, deps);

    return encoded;
}

/**
 * Запускает распознавание ОТДЕЛЬНЫМ фоновым процессом и сразу возвращает jobId.
 * Состояние пишется в `<jobsDir>/<jobId>.json` (status: running|done|failed),
 * опрашивается через readIngestJob. Так MCP-вызов не блокируется на минуты.
 *
 * @returns {{jobId: string, statusPath: string}}
 */
export function startIngestJob(
    opts: IngestJobOptions,
    deps: IngestJobDeps = {},
): { jobId: string; statusPath: string } {
    const {
        filePath,
        workDir,
        frames = 0,
        jobsDir,
        pythonPath = VENV_PYTHON,
        transcribePath = DEFAULT_TRANSCRIBE_PY,
        mediaHfDir = DEFAULT_MEDIA_HF_DIR,
        baseEnv = process.env,
        workerPath = DEFAULT_WORKER_PATH,
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
        initialPrompt: opts.initialPrompt,
        wordTimestamps: opts.wordTimestamps,
    }, 'video');
    const job = encodeJob({
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
    const childEnv = buildPythonEnv({ mediaHfDir, pythonPath, baseEnv });
    if (pythonPath) childEnv.COCKPIT_MEDIA_PYTHON = pythonPath;
    childEnv.COCKPIT_TRANSCRIBE_PY = transcribePath || DEFAULT_TRANSCRIBE_PY;
    childEnv.COCKPIT_MEDIA_HF_DIR = mediaHfDir;
    const child = (deps.spawn || spawn)(process.execPath, [workerPath, statusPath], {
        detached: true,
        stdio: 'ignore',
        env: childEnv,
    });

    // Провал запуска приходит событием уже после возврата spawn. Без этой ветки
    // задача навсегда осталась бы «выполняется»: воркер, который её закроет,
    // не запустился вовсе.
    child.once('error', (error: Error) => {
        abandonIngestJob(statusPath, `Не удалось запустить разбор: ${error.message}`, deps);
    });
    child.unref();
    rememberIngestWorker(jobWorkerPath(jobsDir, jobId), child.pid, deps);

    return { jobId, statusPath };
}

/**
 * Запоминает, кто считает задачу. Метка нужна только для того, чтобы брошенную
 * задачу можно было отличить от идущей: без неё оборванный воркер оставляет
 * «выполняется» навсегда. Отсутствие метки трактуется в пользу задачи.
 */
function rememberIngestWorker(
    workerPath: string,
    pid: number | undefined,
    deps: IngestJobDeps,
): void {
    if (!Number.isInteger(pid) || Number(pid) <= 0) {
        return;
    }
    const identity = (deps.readProcessIdentity || readIdentity)(Number(pid));
    const record: IngestWorkerProcess = { pid: Number(pid), starttime: identity?.starttime ?? null };

    try {
        writeJsonFile(workerPath, record, deps);
    } catch {
        // Задача уже запущена; без метки чинить её будет нечем, но терять её нельзя.
    }
}

/**
 * Переводит задачу в отказ, если она всё ещё считается идущей. Записанный итог
 * не трогаем: воркер мог завершиться ровно между проверкой и этой записью, и
 * подменять его результат отказом означало бы потерять готовый разбор.
 */
function abandonIngestJob(
    statusPath: string,
    message: string,
    deps: IngestJobReadDeps,
): IngestJob | null {
    const settled = loadIngestJobFile(statusPath);

    if (!settled || settled.status !== 'running') {
        return settled;
    }

    try {
        return writeIngestJobFile(statusPath, {
            ...settled,
            status: 'failed',
            finishedAt: (deps.now || Date.now)(),
            error: message,
        }, deps);
    } catch {
        return settled;
    }
}

/**
 * Извлекает кадры в КОНКРЕТНЫЕ секунды видео (для скриншотов под задачи).
 * Всё локально (ffmpeg в том же окружении) — видео не покидает сервер.
 *
 * `prefix` нужен, когда в один каталог пишут кадры РАЗНЫХ файлов: у встречи из
 * нескольких частей секунды локальные, и одинаковая секунда второй части затирала бы
 * кадр первой.
 *
 * @param {{filePath: string, seconds: number[], destDir: string, prefix?: string}} opts
 * @returns {Promise<Array<{seconds: number, path: string}>>}
 */
export async function extractFramesAt({
    filePath,
    seconds,
    destDir,
    prefix = 'frame-',
}: {
    filePath: string;
    seconds: number[];
    destDir: string;
    prefix?: string;
}, deps: { runProcess?: ProcessRunner } = {}): Promise<{ seconds: number; path: string }[]> {
    if (!existsSync(filePath)) {
        throw new Error(`Файл не найден: ${filePath}`);
    }
    mkdirSync(destDir, { recursive: true });

    const out: { seconds: number; path: string }[] = [];

    for (const sec of seconds) {
        const tag = String(Math.round(sec)).padStart(5, '0');
        const dst = join(destDir, `${prefix}${tag}s.jpg`);
        // -ss до -i = быстрый input-seek; один кадр, даунскейл до 1280.
        await (deps.runProcess || runProcess)('ffmpeg', [
            '-y', '-ss', String(sec), '-i', filePath,
            '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', dst,
        ]);
        out.push({ seconds: sec, path: dst });
    }
    return out;
}

// Ниже этого фрагмент считается несостоявшимся: у mp4 один только заголовок весит
// сотни байт, поэтому меньше килобайта означает пустой вывод, а не короткий кусок.
const MIN_CLIP_BYTES = 1024;

// Вырезанный фрагмент: где он лежит, какое место записи показывает и сколько весит.
// Вес проверяется отдельно — пустой файл ffmpeg отдаёт с нулевым кодом.
export interface MeetingClipFile {
    from: number;
    seconds: number;
    path: string;
    bytes: number;
}

/**
 * Вырезает фрагмент записи вокруг места задачи (превью в разделе и вложение к задаче).
 *
 * Перекодирование, а не `-c copy`: копия режется только по ключевым кадрам, то есть
 * начало уезжает на секунды от нужного места, а вес остаётся исходным. Замер на записи
 * созвона 1080p: 30 секунд в 1280p дают около 400 КБ за полторы секунды работы — это и
 * смотреть быстро, и грузить на портал не жалко.
 *
 * Отсутствие видеодорожки — не поломка, а обычная аудиозапись, поэтому проверяется
 * ДО ffmpeg и называется отдельной ошибкой: иначе человек читал бы про неизвестный
 * отказ кодека там, где резать просто нечего.
 *
 * @param {{filePath:string, from:number, seconds:number, destDir:string,
 *          prefix?:string}} opts
 * @returns {Promise<{from:number, seconds:number, path:string, bytes:number}>}
 */
export async function cutClipAt({
    filePath,
    from,
    seconds,
    destDir,
    prefix = 'clip-',
}: {
    filePath: string;
    from: number;
    seconds: number;
    destDir: string;
    prefix?: string;
}, deps: { runProcess?: ProcessRunner } = {}): Promise<MeetingClipFile> {
    if (!existsSync(filePath)) {
        throw new Error(`Файл не найден: ${filePath}`);
    }

    const runner = deps.runProcess || runProcess;
    const { hasVideo } = await probeStreams(filePath, runner);

    if (!hasVideo) {
        const error: ProcessFailure & { code?: string } = new Error(
            'В записи нет видеодорожки — резать нечего.',
        );
        error.code = 'no_video';
        throw error;
    }

    mkdirSync(destDir, { recursive: true });

    const start = Math.max(0, Math.round(from));
    const length = Math.max(1, Math.round(seconds));
    const tag = `${String(start).padStart(5, '0')}-${String(Math.min(999, length)).padStart(3, '0')}s`;
    const dst = join(destDir, `${prefix}${tag}.mp4`);

    // -ss до -i = быстрый input-seek; с перекодированием он же остаётся точным.
    // faststart двигает moov в начало файла: без него браузер тянет весь файл прежде,
    // чем показать первый кадр, а портал не отдаёт превью.
    await runner('ffmpeg', [
        '-y', '-ss', String(start), '-i', filePath, '-t', String(length),
        '-vf', "scale='min(1280,iw)':-2",
        '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast',
        '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
        '-movflags', '+faststart',
        dst,
    ]);

    // Пустой файл при НУЛЕВОМ коде — обычный исход `-ss` за концом записи: длительность
    // части могла не прочитаться, и кламп по ней не сработал. Проверяется именно
    // размер, потому что иначе к задаче уехало бы вложение, которое не открывается.
    const bytes = statSync(dst).size;
    if (bytes < MIN_CLIP_BYTES) {
        rmSync(dst, { force: true });
        const error: ProcessFailure & { code?: string } = new Error(
            `Фрагмент пуст: ${start} с за пределами записи.`,
        );
        error.code = 'empty_clip';
        throw error;
    }

    return { from: start, seconds: length, path: dst, bytes };
}

/**
 * Какие дорожки есть у файла. Отдельно от `probe`: тому нужна длительность вместе с
 * аудио, а здесь важен ровно вопрос «есть ли картинка», и лишний разбор длительности
 * на каждый фрагмент не нужен.
 */
async function probeStreams(
    file: string,
    runner: ProcessRunner,
    signal: AbortSignal | undefined = undefined,
): Promise<{ hasVideo: boolean; hasAudio: boolean }> {
    const { out } = await runner('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=codec_type',
        '-of', 'json',
        file,
    ], { signal });
    const streams = (JSON.parse(out || '{}') as {
        streams?: { codec_type?: string }[];
    }).streams || [];
    return {
        hasVideo: streams.some((s) => s.codec_type === 'video'),
        hasAudio: streams.some((s) => s.codec_type === 'audio'),
    };
}

/** Состояние задачи с диска. null — задачи нет либо файл читали в момент записи. */
function loadIngestJobFile(statusPath: string): IngestJob | null {
    if (!existsSync(statusPath)) {
        return null;
    }

    try {
        return decodeJob(readFileSync(statusPath, 'utf-8'));
    } catch {
        // файл могли писать в момент чтения — пусть опросят ещё раз
        return null;
    }
}

/** Метка воркера с диска: её может не быть у задач, запущенных до её появления. */
function loadIngestWorker(workerPath: string): IngestWorkerProcess | null {
    if (!existsSync(workerPath)) {
        return null;
    }

    try {
        const value: unknown = JSON.parse(readFileSync(workerPath, 'utf-8'));
        const record = value as { pid?: unknown; starttime?: unknown };

        if (!Number.isInteger(record.pid) || Number(record.pid) <= 0) {
            return null;
        }
        return {
            pid: Number(record.pid),
            starttime: typeof record.starttime === 'string' ? record.starttime : null,
        };
    } catch {
        return null;
    }
}

/**
 * Жив ли записанный воркер. Момент старта сверяется, когда он известен: PID
 * переиспользуются, и без этой сверки чужой процесс выдавал бы себя за наш.
 * Неизвестный момент старта оставляет задачу идущей — ложный отказ хуже ожидания.
 */
function ingestWorkerAlive(worker: IngestWorkerProcess, deps: IngestJobReadDeps): boolean {
    const actual = (deps.readProcessIdentity || readIdentity)(worker.pid);

    if (!actual) {
        return false;
    }
    return worker.starttime === null || actual.starttime === worker.starttime;
}

/**
 * Читает состояние задачи распознавания. null — если задачи нет.
 *
 * Заодно закрывает брошенные задачи: воркер отсоединён, и его гибель никто не
 * замечает, поэтому «выполняется» без живого процесса означает оборванный разбор,
 * а не идущий. Готовый результат при этом не переписывается — он перечитывается.
 */
export function readIngestJob(
    jobId: string,
    jobsDir: string,
    deps: IngestJobReadDeps = {},
): IngestJob | null {
    const statusPath = jobStatusPath(jobsDir, jobId);
    const job = loadIngestJobFile(statusPath);

    if (!job || job.status !== 'running') {
        return job;
    }

    const worker = loadIngestWorker(jobWorkerPath(jobsDir, jobId));

    if (!worker || ingestWorkerAlive(worker, deps)) {
        return job;
    }

    return abandonIngestJob(
        statusPath,
        'Процесс распознавания завершился, не записав результат.',
        deps,
    );
}
