// Извлечение картинок, вставленных пользователем прямо в чат Claude Code.
//
// Зачем: MCP-сервер — отдельный процесс, он не видит контекст модели. Картинка,
// которую пользователь вставил в чат, до сервера сама не доедет — у инструментов
// загрузки на вход только путь к файлу. Но Claude Code пишет весь диалог в
// транскрипт сессии (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`), и
// вставленные картинки лежат там как base64. Этот модуль достаёт их оттуда на диск,
// после чего путь скармливается в b24_create_task/b24_comment (images).
//
// Важно отличать ВСТАВКУ ПОЛЬЗОВАТЕЛЯ от картинок в результатах инструментов:
//   • вставка     — строка role:'user', блок {type:'image'} прямо в message.content;
//   • из tool_result — блок {type:'tool_result', content:[{type:'image'}]} (роль тоже
//     'user', т.к. результаты инструментов возвращаются как user-сообщения) — игнорируем;
//   • от ассистента — role:'assistant' — игнорируем.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const EXT_BY_MEDIA = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
};

/**
 * Каталог транскриптов Claude Code. Можно переопределить переменной
 * CLAUDE_PROJECTS_DIR (на случай нестандартного расположения).
 */
export function projectsDir() {
    return process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
}

/**
 * Находит транскрипт активной сессии — самый свежий по времени изменения `.jsonl`
 * во всех подкаталогах проектов. В момент вызова инструмента текущая сессия только
 * что дописала в свой транскрипт tool-use, поэтому «самый свежий» = текущий
 * (даже если параллельно открыты другие вкладки/слоты).
 * @returns {string|null} абсолютный путь к .jsonl или null
 */
export function findActiveTranscript() {
    const root = projectsDir();
    if (!existsSync(root)) {
        return null;
    }
    let best = null;
    for (const sub of readdirSync(root)) {
        const dir = join(root, sub);
        let st;
        try {
            st = statSync(dir);
        } catch {
            continue;
        }
        if (!st.isDirectory()) {
            continue;
        }
        for (const f of readdirSync(dir)) {
            if (!f.endsWith('.jsonl')) {
                continue;
            }
            const p = join(dir, f);
            const m = statSync(p).mtimeMs;
            if (!best || m > best.mtime) {
                best = { path: p, mtime: m };
            }
        }
    }
    return best?.path ?? null;
}

/**
 * Достаёт из транскрипта все картинки, вставленные пользователем (в порядке появления).
 * @param {string} transcriptPath путь к .jsonl
 * @returns {Array<{mediaType:string, data:string, lineIndex:number}>}
 */
export function readPastedImages(transcriptPath) {
    const lines = readFileSync(transcriptPath, 'utf8').split('\n');
    const out = [];
    lines.forEach((ln, lineIndex) => {
        if (!ln) {
            return;
        }
        let o;
        try {
            o = JSON.parse(ln);
        } catch {
            return;
        }
        const msg = o?.message;
        if (msg?.role !== 'user' || !Array.isArray(msg.content)) {
            return;
        }
        for (const block of msg.content) {
            // только image-блоки ВЕРХНЕГО уровня (не внутри tool_result)
            if (block?.type === 'image' && block.source?.type === 'base64' && block.source?.data) {
                out.push({
                    mediaType: block.source.media_type || 'image/png',
                    data: block.source.data,
                    lineIndex,
                });
            }
        }
    });
    return out;
}

/**
 * Материализует последние N вставленных картинок на диск.
 * @param {object} opts
 * @param {string|null} opts.transcriptPath явный путь к транскрипту (по умолчанию — активная сессия)
 * @param {number} opts.count сколько последних картинок достать (по умолчанию 1)
 * @param {string} opts.destDir куда сохранять
 * @returns {{ transcriptPath:string, total:number, files:Array<{path,mediaType,bytes}> }}
 */
export function extractPastedImages({ transcriptPath = null, count = 1, destDir }) {
    const tp = transcriptPath || findActiveTranscript();
    if (!tp) {
        throw new Error('Не найден транскрипт сессии Claude Code (~/.claude/projects/**/*.jsonl).');
    }
    if (!existsSync(tp)) {
        throw new Error(`Транскрипт не найден: ${tp}`);
    }
    const all = readPastedImages(tp);
    if (all.length === 0) {
        return { transcriptPath: tp, total: 0, files: [] };
    }
    const picked = all.slice(-Math.max(1, count));
    mkdirSync(destDir, { recursive: true });

    const files = picked.map((img, i) => {
        const ext = EXT_BY_MEDIA[img.mediaType] || 'png';
        // Имя стабильно в пределах запроса; индекс — чтобы несколько картинок не перетёрлись.
        const path = join(destDir, `chat-paste-${img.lineIndex}-${i}.${ext}`);
        const buf = Buffer.from(img.data, 'base64');
        writeFileSync(path, buf);
        return { path, mediaType: img.mediaType, bytes: buf.length };
    });

    return { transcriptPath: tp, total: all.length, files };
}
