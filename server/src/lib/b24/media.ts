// Извлечение и скачивание медиа из описаний задач.
//
// Картинки в задачах чаще всего — ВНЕШНИЕ ссылки (Яндекс.Диск, прямые URL),
// а не вложения Битрикса (их getTaskDetails не отдаёт). Публичные ссылки
// Яндекс.Диска резолвятся в прямой URL через cloud-api без авторизации.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

// Что за ссылка попалась в описании. Скачиваем только то, что действительно файл:
// приватную ссылку телеграма и видео мы не тянем, но и не прячем от человека.
export type MediaKind = 'yandex-disk' | 'image' | 'video' | 'telegram-private' | 'telegram' | 'link';

export interface MediaLink {
    url: string;
    kind: MediaKind;
    fetchable: boolean;
}

// Скачанный файл: где лежит, чем оказался и сколько весит.
export interface DownloadedMedia {
    path: string;
    contentType: string;
    bytes: number;
    isImage: boolean;
}

// Итог по одной ссылке: скачано, пропущено или отказ с причиной.
export type TaskMediaResult = MediaLink & Partial<DownloadedMedia> & {
    status: 'downloaded' | 'skipped' | 'resolve-failed' | 'error';
    error?: string;
};

const EXT_BY_CT: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
};

// fetch с одним повтором — внешние сервисы (Яндекс.Диск) иногда дают сетевой блип.
async function fetchRetry(url: string, opts?: RequestInit, tries = 2): Promise<Response> {
    let lastErr: unknown;
    for (let i = 0; i < tries; i += 1) {
        try {
            return await fetch(url, opts);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr;
}

/**
 * Классифицирует одну ссылку.
 */
function classify(url: string): MediaLink {
    const u = url.replace(/[.,);]+$/, '');
    if (/disk\.yandex\.(ru|com)\/(i|d)\//.test(u)) {
        return { url: u, kind: 'yandex-disk', fetchable: true };
    }
    if (/\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(u)) {
        return { url: u, kind: 'image', fetchable: true };
    }
    if (/\.(mp4|mov|webm|avi|mkv)(\?|$)/i.test(u)) {
        return { url: u, kind: 'video', fetchable: false };
    }
    if (/t\.me\/c\//.test(u)) {
        return { url: u, kind: 'telegram-private', fetchable: false };
    }
    if (/t\.me\//.test(u)) {
        return { url: u, kind: 'telegram', fetchable: false };
    }
    return { url: u, kind: 'link', fetchable: false };
}

/**
 * Достаёт все ссылки из (сырого) описания задачи и классифицирует их.
 */
export function extractMediaLinks(rawDescription: unknown): MediaLink[] {
    const urls = [...new Set(String(rawDescription || '').match(/https?:\/\/[^\s"'<>)]+/g) || [])];
    return urls.map(classify);
}

/**
 * Публичная ссылка Яндекс.Диска -> прямой URL для скачивания (без авторизации).
 */
export async function resolveYandexDisk(publicUrl: string): Promise<string | null> {
    const api =
        'https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=' +
        encodeURIComponent(publicUrl);
    const res = await fetchRetry(api);
    if (!res.ok) {
        return null;
    }
    const j = await res.json() as { href?: unknown } | null;

    return typeof j?.href === 'string' ? j.href : null;
}

/**
 * Скачивает файл в destDir. Имя берёт из URL/ContentType.
 */
export async function downloadTo(
    url: string,
    destDir: string,
    preferredName: string | null = null,
): Promise<DownloadedMedia> {
    const res = await fetchRetry(url);
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    const ct = (res.headers.get('content-type') || '').split(';')[0]?.trim() ?? '';
    const buf = Buffer.from(await res.arrayBuffer());

    let name = preferredName || basename(new URL(url).pathname) || 'file';

    name = name.split('?')[0] || 'file';

    // Доклеиваем расширение по content-type, если в имени его нет.
    const ext = EXT_BY_CT[ct];

    if (!/\.[a-z0-9]{2,4}$/i.test(name) && ext) {
        name += `.${ext}`;
    }

    mkdirSync(destDir, { recursive: true });
    const path = join(destDir, name);
    writeFileSync(path, buf);
    return { path, contentType: ct, bytes: buf.length, isImage: ct.startsWith('image/') };
}

/** Скачивает все скачиваемые медиа задачи в destDir; остальные ссылки помечает. */
export async function fetchTaskMedia(
    description: unknown,
    destDir: string,
): Promise<TaskMediaResult[]> {
    const links = extractMediaLinks(description);
    const out: TaskMediaResult[] = [];
    let idx = 0;
    for (const l of links) {
        idx += 1;
        if (l.kind === 'yandex-disk') {
            try {
                const href = await resolveYandexDisk(l.url);
                if (!href) {
                    out.push({ ...l, status: 'resolve-failed' });
                    continue;
                }
                const dl = await downloadTo(href, destDir, `yadisk-${idx}`);
                out.push({ ...l, status: 'downloaded', ...dl });
            } catch (e) {
                out.push({
                    ...l,
                    status: 'error',
                    error: String((e as { message?: unknown } | null)?.message || e),
                });
            }
        } else if (l.kind === 'image') {
            try {
                const dl = await downloadTo(l.url, destDir);
                out.push({ ...l, status: 'downloaded', ...dl });
            } catch (e) {
                out.push({
                    ...l,
                    status: 'error',
                    error: String((e as { message?: unknown } | null)?.message || e),
                });
            }
        } else {
            out.push({ ...l, status: 'skipped' });
        }
    }
    return out;
}
