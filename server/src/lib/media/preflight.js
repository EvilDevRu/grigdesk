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

// Python из venv с faster-whisper. Путь ТОЛЬКО из окружения (runtime-venv тяжёлый —
// около 492 МБ плюс модель в общем cache; машинных путей в исходнике нет).
//
// Значения по умолчанию сознательно нет: своего venv у кокпита не бывает, и любой «путь на
// всякий случай» — это ложь про настроенное окружение. Раньше тут был fallback на
// `<каталог файла>/../.venv/bin/python` — наследство прежней раскладки, где файл лежал в
// src/media/ и `..` попадал в корень внешнего проекта. После переезда в server/src/lib/media/ он стал
// указывать на server/src/lib/.venv, которого нет и не будет: вместо внятного «не настроено»
// диктовка отвечала `spawn .../lib/.venv/bin/python ENOENT`.
export const VENV_PYTHON = process.env.COCKPIT_MEDIA_PYTHON || '';

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

    const venv = Boolean(VENV_PYTHON) && existsSync(VENV_PYTHON);
    checks.push({
        name: VENV_PYTHON
            ? `python venv (${VENV_PYTHON})`
            : 'python venv (COCKPIT_MEDIA_PYTHON не задан)',
        ok: venv,
        fix: 'COCKPIT_MEDIA_PYTHON=<путь к venv>/bin/python в корневом .env кокпита + перезапуск сервера',
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
        fix: venv ? `${VENV_PYTHON} -m pip install faster-whisper` : 'тот же venv: python -m pip install faster-whisper',
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
    // Уникальные шаги починки в порядке появления (apt раньше настройки путей).
    const fixes = [...new Set(pf.checks.filter((c) => !c.ok).map((c) => c.fix))];
    // Runtime не ставится при обычном npm install: подсказываем воспроизводимый локальный путь.
    const venvMissing = pf.checks.some((c) => c.name.startsWith('python venv') && !c.ok);
    const notes = venvMissing
        ? ['', 'Создать: python3 -m venv server/.state/media-venv && server/.state/media-venv/bin/pip install -r server/requirements-media.txt']
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
