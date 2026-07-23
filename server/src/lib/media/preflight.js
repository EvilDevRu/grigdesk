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

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Корень проекта b24-mcp (на уровень выше src/).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Python из локального venv, куда npm run setup ставит faster-whisper.
// Python из venv с faster-whisper. Путь конфигурируется окружением (venv тяжёлый,
// переиспользуем существующий) — в исходнике проектных путей нет.
export const VENV_PYTHON = process.env.COCKPIT_MEDIA_PYTHON || join(ROOT, '.venv', 'bin', 'python');

/**
 * Проверяет, что бинарь существует в PATH (по коду ошибки ENOENT при spawn).
 */
function commandPresent(cmd, args = ['-version']) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    return !(r.error && r.error.code === 'ENOENT');
}

/**
 * Прогоняет все проверки окружения и возвращает структурированный отчёт.
 *
 * @returns {{ok: boolean, checks: Array<{name: string, ok: boolean, fix: string}>, venvPython: string}}
 */
export function preflight() {
    const checks = [];

    const ffmpeg = commandPresent('ffmpeg');
    checks.push({
        name: 'ffmpeg (извлечение аудио/кадров)',
        ok: ffmpeg,
        fix: 'sudo apt install -y ffmpeg',
    });

    const ffprobe = commandPresent('ffprobe');
    checks.push({
        name: 'ffprobe (длительность/метаданные)',
        ok: ffprobe,
        fix: 'sudo apt install -y ffmpeg   (ffprobe идёт в том же пакете)',
    });

    const venv = existsSync(VENV_PYTHON);
    checks.push({
        name: 'python venv (.venv)',
        ok: venv,
        fix: 'npm run setup',
    });

    // faster-whisper проверяем только если venv вообще есть.
    let whisper = false;
    if (venv) {
        const r = spawnSync(VENV_PYTHON, ['-c', 'import faster_whisper'], { stdio: 'ignore' });
        whisper = r.status === 0;
    }
    checks.push({
        name: 'faster-whisper (распознавание речи)',
        ok: whisper,
        fix: 'npm run setup',
    });

    return { ok: checks.every((c) => c.ok), checks, venvPython: VENV_PYTHON };
}

/**
 * Человекочитаемый отчёт по результату preflight() с инструкциями по недостающему.
 */
export function preflightReport(pf) {
    const lines = pf.checks.map((c) => `  ${c.ok ? '✅' : '❌'} ${c.name}`);
    if (pf.ok) {
        return ['🩺 Окружение для разбора видео готово:', ...lines].join('\n');
    }
    // Уникальные шаги починки в порядке появления (apt раньше npm).
    const fixes = [...new Set(pf.checks.filter((c) => !c.ok).map((c) => c.fix))];
    // Если нет самого venv — модуль python3-venv может быть не установлен системно.
    const venvMissing = pf.checks.some((c) => c.name.startsWith('python venv') && !c.ok);
    const notes = venvMissing
        ? ['', 'Если `npm run setup` пожалуется на venv:  sudo apt install -y python3-venv']
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
